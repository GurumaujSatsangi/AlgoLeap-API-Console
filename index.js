import express from "express";
import bodyParser from "body-parser";
import passport from "passport";
import crypto from "crypto";
import Razorpay from "razorpay";
import { v4 as uuidv4 } from "uuid";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import session from "express-session";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, Modality } from "@google/genai";
import * as fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import wav from "wav";
import { ElevenLabsClient } from "elevenlabs";

const app = express();
dotenv.config();

const elevenLabs = new ElevenLabsClient({apiKey:process.env.ELEVENLABS_API_KEY});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const instance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || "your_secret_key",
    resave: false,
    saveUninitialized: false,
  })
);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
const ai = new GoogleGenAI(process.env.GOOGLE_API_KEY);
const port = process.env.PORT || 3000;
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(passport.initialize());
app.use(passport.session());

app.get("/", (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect("/dashboard");
  }
  res.render("home.ejs");
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

app.get("/dashboard", async (req, res) => {
  const message = req.query.message || null; // Get message from query params
  if (req.isAuthenticated()) {
    const { data: enabledApis, error } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("uid", req.user.uid);

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).send("Database error");
    }

    res.render("dashboard", {
      user: req.user,
      enabledApis, // ✅ we're using enabledApis here, not data
      textOutput: null,
      message, // Initialize message to null
    });
  } else {
    res.redirect("/");
  }
});

app.get(
  "/auth/google/dashboard",
  passport.authenticate("google", {
    failureRedirect: "/",
    successRedirect: "/dashboard",
  }),
  async (req, res) => {
    const { data, error } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("uid", req.user.uid)
      .single(); // since only 1 key per user

    if (error && error.code !== "PGRST116") {
      console.error(error);
      return res.send("Database error!");
    }

    res.render("dashboard.ejs", {
      user: req.user,
      enabledApis: data ? [data] : [],
      textOutput: null, // Initialize textOutput to null
      message, // Initialize message to null
    });
  }
);

app.get("/generate-api-key", async (req, res) => {
  const uid = req.user.uid;
  const generatedApiKey = crypto.randomUUID();

  try {
    const { data: existingKeys, error: selectError } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("uid", uid);

    if (selectError) {
      console.error(selectError);
res.redirect("/dashboard?message=Error fetching existing API keys.");   };

    if (existingKeys.length > 0) {
res.redirect("/dashboard?message=You already have an API Key.");     }

    const { error: insertError } = await supabase.from("enabled_apis").insert([
      {
        uid,
        api_key: generatedApiKey,
        credits: 5,
        status: "enabled",
        account_status: "trial",
      },
    ]);

    if (insertError) {
      console.error(insertError);
res.render("dashboard", {message: "Error creating API key."});}

    return res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    return res.send("Server error!");
  }
});

app.post("/create-order", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("enabled_apis")
      .select("account_status")
      .eq("uid", req.user.uid)
      .single();

    if (error) {
res.render("dashboard", {message: "Error fetching account status."});}

    if (data?.account_status === "premium plan") {
res.redirect('/dashboard?message=You already have a Premium Plan.');
return;
    } else {
      const options = {
        amount: 49900,
        currency: "INR",
        receipt: "receipt_" + Date.now(),
        notes: {
          userId: req.user.uid,
          email: req.user.email,
        },
      };

      const order = await instance.orders.create(options);
      res.render("checkout", {
        razorpayKey: process.env.RAZORPAY_KEY_ID,
        orderId: order.id,
        amount: options.amount,
        currency: options.currency,
      });
    }
  } catch (err) {
    console.error(err);
res.redirect('/dashboard?message=Error creating order.');}
});

app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;

  const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
  hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
  const generated_signature = hmac.digest("hex");
  const payment = await instance.payments.fetch(razorpay_payment_id);
  if (generated_signature === razorpay_signature) {
    await supabase
      .from("enabled_apis")
      .update({
        credits: 1000,
        status: "enabled",
        account_status: "premium plan",
      })
      .eq("uid", payment.notes.userId);
res.json({ success: true});}
      else{
res.json({ success: false});
  }
});

app.post("/image", async (req, res) => {
  const { prompt, apiKey } = req.query;

  if (!prompt || !apiKey) {
    return res.status(400).send("Missing prompt or API key");
  }

  try {
    const { data: keys, error: dbError } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("api_key", apiKey);

    if (!keys || keys.length === 0) {
      return res.status(403).send("API key not found!");
    } else if (keys[0].credits == 0) {
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res
        .status(403)
        .send(
          "You have consumed your trial credits, your API key has been disabled."
        );
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-preview-image-generation",
      contents: prompt,
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
      },
    });

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;
        const buffer = Buffer.from(imageData, "base64");

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", "inline; filename=image.png");

        return res.end(buffer);
      }
    }

    res.status(500).send("No image data returned");
  } catch (error) {
    console.error(error);
    res.status(500).send("Something went wrong");
  } 
    await supabase
      .from("enabled_apis")
      .update({ credits: keys[0].credits - 1 })
      .eq("api_key", apiKey);
  
});

app.post("/text", async (req, res) => {
    const { prompt, apiKey } = req.query;


  if (!prompt || !apiKey) {
    return res.status(400).send("Missing prompt or API key");
  }

  try {
    // Check if API key is valid
    const { data: keys, error: dbError } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("api_key", apiKey);

    if (!keys || keys.length === 0) {
      return res.status(403).send("API key not found!");
    } else if (keys[0].credits == 0) {
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res
        .status(403)
        .send(
          "You have consumed your trial credits, your API key has been disabled."
        );
    }

    // Call the AI model
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    const textOutput = response.text || response.content || "No response text"; // Adjust as per API structure

    res.send(textOutput);

    await supabase
      .from("enabled_apis")
      .update({ credits: keys[0].credits - 1 })
      .eq("api_key", apiKey);
  } catch (error) {
    console.error(error);
    res.status(500).send("Something went wrong");
  }
});

app.post("/genai", async (req, res) => {
  const { prompt, apiKey } = req.query;

  if (!prompt || !apiKey) {
    return res.status(400).send("Missing prompt or API key");
  }

  try {
    // Check if API key is valid
    const { data: keys, error: dbError } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("api_key", apiKey);

    if (!keys || keys.length === 0) {
      return res.status(403).send("API key not found!");
    } else if (keys[0].credits == 0) {
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res
        .status(403)
        .send(
          "You have consumed your trial credits, your API key has been disabled."
        );
    }

    if (prompt.includes("image")) {
      const imageresponse = await axios.post(
        `https://algoleap-api-console.onrender.com/image?prompt=${prompt}&apiKey=${apiKey}`, {},   { responseType: "arraybuffer" } // <- critical

      );
const imageBuffer = Buffer.from(imageresponse.data);

  const imagePath = path.join(__dirname, "image.png");

  fs.writeFileSync(imagePath, imageBuffer);

  res.sendFile("image.png", { root: __dirname });
  return;
    } else if (prompt.includes("audio")) {
  const audioresponse = await axios.post(
    `https://algoleap-api-console.onrender.com/audio?prompt=${prompt}&apiKey=${apiKey}`,
    null, // ⬅️ Explicitly no request body
    {
      responseType: "arraybuffer", // ⬅️ Critical for binary data
    }
  );

  res.setHeader("Content-Type", "audio/wav");
  res.send(audioresponse.data); // stream the audio to the user
  return;
}

else {
      const textresponse = await axios.post(
        `https://algoleap-api-console.onrender.com/text?prompt=${prompt}&apiKey=${apiKey}`
      );
      res.send(textresponse.data);
      return;
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Something went wrong");
  }
});

passport.use(
  "google",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        "https://algoleap-api-console.onrender.com/auth/google/dashboard",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    },
    async (accessToken, refreshToken, profile, cb) => {
      try {
        const result = await supabase
          .from("users")
          .select("*")
          .eq("uid", profile.id)
          .single();
        console.log(profile);
        if (!result.data) {
          const { error } = await supabase.from("users").insert([
            {
              uid: profile.id,
              name: profile.displayName,
              email: profile.emails[0].value,
              profile_picture: profile.photos[0].value,
            },
          ]);
          if (error) {
            console.error("Error inserting user:", error);
            return cb(error);
          }

          // Now re-fetch inserted user to pass a clean object to Passport
          const { data: newUser, error: fetchError } = await supabase
            .from("users")
            .select("*")
            .eq("uid", profile.id)
            .single();

          if (fetchError) {
            console.error("Fetch after insert failed:", fetchError);
            return cb(fetchError);
          }

          return cb(null, newUser);
        } else {
          return cb(null, result.data);
        }
      } catch (err) {
        return cb(err);
      }
    }
  )
);
passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});
app.get("/logout", (req, res) => {
  req.logout(function (err) {
    if (err) {
      return next(err);
    }
    res.redirect("/");
  });
});



app.post("/audio", async (req, res) => {
  const { prompt, apiKey } = req.query;

  if (!prompt || !apiKey) {
    return res.status(400).send("Missing prompt or API key");
  }

  try {
    console.log("Checking API key:", apiKey);
    const { data: keys, error: dbError } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("api_key", apiKey);

    if (dbError) throw dbError;

    if (!keys || keys.length === 0) {
      return res.status(403).send("API key not found!");
    }

    if (keys[0].credits == 0) {
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res.status(403).send("You have consumed your trial credits.");
    }

    // ✅ Correct usage of elevenLabs
    const audioStream = await elevenLabs.textToSpeech.convert("JBFqnCBsd6RMkjVDRZzb", {
      output_format: "mp3_44100_128",
      text: prompt,
      model_id: "eleven_multilingual_v2",
    });

    // ✅ Stream audio to response
    res.setHeader("Content-Type", "audio/mpeg");
    audioStream.pipe(res); // Stream it directly

    // ✅ Deduct credits
    await supabase
      .from("enabled_apis")
      .update({ credits: keys[0].credits - 1 })
      .eq("api_key", apiKey);
  } catch (error) {
    console.error("🔥 AUDIO GENERATION ERROR:", error);
    res.status(500).send("Something went wrong");
  }
});


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
