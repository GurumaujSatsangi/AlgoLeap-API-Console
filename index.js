import express from "express";
import bodyParser from "body-parser";
import passport from "passport";
import bcrypt from "bcrypt";
import { v2 as cloudinary } from "cloudinary";
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
import { createClient as createRedisClient } from "redis";
import { Readable } from "node:stream";
const app = express();
dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const instance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});




cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});



const redisClient = createRedisClient({
  url: process.env.REDIS_URL,
});
await redisClient.connect();  



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
app.use("/static", express.static(path.join(__dirname, "public")));

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
  const message = req.query.message || null;

  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const uid = req.user.uid;
const cacheKey = `dashboard:${uid}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const { enabledApis, history, transaction } = JSON.parse(cached);
      return res.render("dashboard", {
        user: req.user,
        enabledApis,
        textOutput: null,
        message,
        history,
        transaction,
      });
    }

    const { data: enabledApis, error } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("uid", uid);

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).send("Database error");
    }

    const { data: history, error: history_error } = await supabase
      .from("prompt_history")
      .select("*")
      .eq("api_key", enabledApis[0]?.api_key);

    const { data: transaction, error: transaction_error } = await supabase
      .from("transaction_history")
      .select("*")
      .eq("uid", uid);

   await redisClient.set(
  cacheKey,
  JSON.stringify({ enabledApis, history, transaction }),
  { EX: 60 * 5 } // 5 minutes expiry
);

    res.render("dashboard", {
      user: req.user,
      enabledApis,
      textOutput: null,
      message,
      history,
      transaction,
    });
  } catch (err) {
    console.error("Redis/DB error:", err);
    res.status(500).send("Server error");
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
      .single(); 
      
      
      const { data: history, history_error } = await supabase
      .from("prompt_history")
      .select("*")
      .eq("api_key", enabledApis[0]?.api_key);

       const { data: transaction,transaction_error } = await supabase
      .from("transaction_history")
      .select("*")
      .eq("uid", req.user.uid)
    if (error && error.code !== "PGRST116") {
      console.error(error);
      return res.send("Database error!");
    }

    res.render("dashboard.ejs", {
      user: req.user,
      enabledApis: data ? [data] : [],
      textOutput: null,
      message,
      history, 
      transaction,
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
      res.redirect("/dashboard?message=Error fetching existing API keys.");
    }

    if (existingKeys.length > 0) {
      res.redirect("/dashboard?message=You already have an API Key.");
    }



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
      res.render("dashboard", { message: "Error creating API key." });
    }

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
      res.render("dashboard", { message: "Error fetching account status." });
    }

    if (data?.account_status === "premium plan") {
      res.redirect("/dashboard?message=You already have a Premium Plan.");
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
    res.redirect("/dashboard?message=Error creating order.");
  }
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

      await supabase.from("transaction_history").insert({
        transaction_id: razorpay_payment_id,

        uid: payment.notes.userId,
        timestamp: new Date().toISOString(),
        transaction_status: payment.status,
      });
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.post("/image", async (req, res) => {
  const { prompt, apiKey } = req.query;

  if (!prompt || !apiKey) {
    return res.status(400).send("Missing prompt or API key");
  }

  try {
    const promptKey = `image:${prompt}`;
    const apiKeyCacheKey = `apikey:${apiKey}`;

    const cachedImage = await redisClient.get(promptKey);
    if (cachedImage) {
      const buffer = Buffer.from(cachedImage, "base64");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", "inline; filename=image.png");
      return res.end(buffer);
    }

    let keyData;
    const cachedKey = await redisClient.get(apiKeyCacheKey);
    if (cachedKey) {
      keyData = JSON.parse(cachedKey);
    } else {
      const { data: keys, error } = await supabase
        .from("enabled_apis")
        .select("*")
        .eq("api_key", apiKey);

      if (error || !keys || keys.length === 0) {
        return res.status(403).send("API key not found!");
      }

      keyData = keys[0];
      await redisClient.setEx(apiKeyCacheKey, 3600, JSON.stringify(keyData)); // Cache for 1 hour
    }

    // 3. Check credits
    if (keyData.credits === 0) {
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res.status(403).send("You have consumed your trial credits, your API key has been disabled.");
    }

    // 4. Generate image using model
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

        await redisClient.setEx(promptKey, 86400, imageData);

        const newCredits = keyData.credits - 1;
        await supabase
          .from("enabled_apis")
          .update({ credits: newCredits })
          .eq("api_key", apiKey);

        keyData.credits = newCredits;
        await redisClient.setEx(apiKeyCacheKey, 3600, JSON.stringify(keyData));

        const buffer = Buffer.from(imageData, "base64");
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", "inline; filename=image.png");
        return res.end(buffer);
      }
    }

    res.status(500).send("No image data returned");
  } catch (error) {
    console.error("Error in /image:", error);
    res.status(500).send("Something went wrong");
  }
});



app.post("/text", async (req, res) => {
  const { prompt, apiKey } = req.query;

  if (!prompt || !apiKey) {
    return res.status(400).send("Missing prompt or API key");
  }

  try {
    let dbKeys;

    // Try to get the API key data from Redis
    const redisValue = await redisClient.get(apiKey); // Use actual API key as Redis key
    if (redisValue) {
      dbKeys = JSON.parse(redisValue);
    } else {
      // If not found in Redis, fetch from Supabase
      const { data, error: dbError } = await supabase
        .from("enabled_apis")
        .select("*")
        .eq("api_key", apiKey);

      if (dbError) {
        console.error("Supabase error:", dbError);
        return res.status(500).send("Database error");
      }

      if (!data || data.length === 0) {
        return res.status(403).send("API key not found!");
      }

      dbKeys = data;

      // Cache in Redis with the actual API key as the key
      await redisClient.set(apiKey, JSON.stringify(dbKeys), 'EX', 3600); // Optional expiry of 1 hour
    }

    if (dbKeys[0].credits === 0) {
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);

      return res.status(403).send("You have consumed your trial credits, your API key has been disabled.");
    }

    // Call the AI model
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    const textOutput = response.text || response.content || "No response text";

    res.send(textOutput);

    // Deduct 1 credit
    await supabase
      .from("enabled_apis")
      .update({ credits: dbKeys[0].credits - 1 })
      .eq("api_key", apiKey);

    // Log prompt history
    await supabase.from("prompt_history").insert({
      api_key: apiKey,
      type: "text",
      prompt,
      response: textOutput,
    });
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
        `https://algoleap-api-console.onrender.com/image?prompt=${prompt}&apiKey=${apiKey}`,
        {},
        { responseType: "arraybuffer" } // <- critical
      );
      const fileName = `${crypto.randomUUID()}.png`;

      const imageBuffer = Buffer.from(imageresponse.data);

      const imagePath = path.join(__dirname, fileName);

      fs.writeFileSync(imagePath, imageBuffer);

      res.sendFile(fileName, { root: __dirname });

      const uploadResult = await cloudinary.uploader
        .upload(fileName, {
          resource_type: "image", // Cloudinary treats audio files as "video"
          public_id: fileName,
        })
        .catch((error) => {
          console.log(error);
        });
      await supabase.from("prompt_history").insert({
        api_key: apiKey,

        type: "image",
        prompt: prompt,
        response: uploadResult?.secure_url || "",
      });

      return;
    } else if (prompt.includes("audio")) {
      async function saveWaveFile(
        filename,
        pcmData,
        channels = 1,
        rate = 24000,
        sampleWidth = 2
      ) {
        return new Promise((resolve, reject) => {
          const writer = new wav.FileWriter(filename, {
            channels,
            sampleRate: rate,
            bitDepth: sampleWidth * 8,
          });

          writer.on("finish", resolve);
          writer.on("error", reject);

          writer.write(pcmData);
          writer.end();
        });
      }
const fileName = `${crypto.randomUUID()}.wav`;

      async function main() {
        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Kore" },
              },
            },
          },
        });

        const data =
          response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        const audioBuffer = Buffer.from(data, "base64");

        await saveWaveFile(fileName, audioBuffer);
      }
      await main();

      const uploadResult = await cloudinary.uploader
        .upload(fileName, {
          resource_type: "video", // Cloudinary treats audio files as "video"
          public_id: fileName,
        })
        .catch((error) => {
          console.log(error);
        });
      await supabase.from("prompt_history").insert({
        api_key: apiKey,
        type: "audio",
        prompt: prompt,
        response: uploadResult?.secure_url || "",
      });

      res.send({
        message: "Audio File Generated Successfully!",
        fileUrl: uploadResult?.secure_url,
      });
       await supabase
        .from("enabled_apis")
        .update({ credits: keys[0].credits - 1 })
        .eq("api_key", apiKey);
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

app.post("/video", async (req, res) => {
  // const { prompt, apiKey } = req.query;

  // if (!prompt || !apiKey) {
  //   return res.status(400).send("Missing prompt or API key");
  // }

  // try {
  //   // Check if API key is valid
  //   const { data: keys, error: dbError } = await supabase
  //     .from("enabled_apis")
  //     .select("*")
  //     .eq("api_key", apiKey);

  //   if (!keys || keys.length === 0) {
  //     return res.status(403).send("API key not found!");
  //   } else if (keys[0].credits == 0) {
  //     await supabase
  //       .from("enabled_apis")
  //       .update({ status: "disabled" })
  //       .eq("api_key", apiKey);
  //     return res
  //       .status(403)
  //       .send(
  //         "You have consumed your trial credits, your API key has been disabled."
  //       );
  //   }

  //   // Call the AI model
  //   const response = await ai.models.generateContent({
  //     model: "gemini-2.5-flash-preview-video",
  //     contents: [{ parts: [{ text: prompt }] }],
  //     config: {
  //       responseModalities: ["VIDEO"],
  //     },
  //   });

  //   const videoUrl = response.candidates[0].content.parts[0].inlineData.data;

  //   res.send(videoUrl);

  //   await supabase
  //     .from("enabled_apis")
  //     .update({ credits: keys[0].credits - 1 })
  //     .eq("api_key", apiKey);
  //   await supabase.from("prompt_history").insert({  
  //     api_key: apiKey,
  //     type: "video",
  //     prompt: prompt,
  //     response: videoUrl || "",
  //   });} catch (error) {
  //   console.error(error);}

 async function main() {
  let operation = await ai.models.generateVideos({
    model: "veo-2.0-generate-001",
    prompt: "Panning wide shot of a calico kitten sleeping in the sunshine",
    config: {
      personGeneration: "dont_allow",
      aspectRatio: "16:9",
    },
  });

  while (!operation.done) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    operation = await ai.operations.getVideosOperation({
      operation: operation,
    });
  }

  operation.response?.generatedVideos?.forEach(async (generatedVideo, n) => {
    const resp = await fetch(`${generatedVideo.video?.uri}&key=GOOGLE_API_KEY`); // append your API key
    const writer = createWriteStream(`video${n}.mp4`);
    Readable.fromWeb(resp.body).pipe(writer);
  });
}

main();
console.log("Video generation started");
  res.send("Video generation started, check your console for progress.");

});







app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
