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
import { GoogleGenAI,Modality } from "@google/genai";
import * as fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import wav from "wav";

const app = express();
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const instance = new Razorpay({ key_id:process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });





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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(passport.initialize());
app.use(passport.session());

app.get("/", (req, res) => {
  res.render("home.ejs");
});

app.get("/auth/google", passport.authenticate("google", {
  scope: ["profile", "email"],
}));

app.get("/dashboard", async (req, res) => {
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
      enabledApis,        // ✅ we're using enabledApis here, not data
      textOutput: null
    });
  } else {
    res.redirect("/");
  }
});

app.get(
  "/auth/google/dashboard",
  passport.authenticate("google", { failureRedirect: "/",successRedirect: "/dashboard" }),
  async (req, res) => {

    const { data, error } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("uid", req.user.uid)
      .single(); // since only 1 key per user

    if (error && error.code !== 'PGRST116') {
      console.error(error);
      return res.send("Database error!");
    }

    res.render("dashboard.ejs", {
      user: req.user,
      enabledApis: data ? [data] : [],
      textOutput: null, // Initialize textOutput to null
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
      return res.send("Database error!");
    }

    if (existingKeys.length > 0) {
    return res.redirect("/dashboard");
    }

    const { error: insertError } = await supabase
      .from("enabled_apis")
      .insert([
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
      return res.send("API key generation failed.");
    }

    return res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    return res.send("Server error!");
  }
});

  
app.post("/image", async (req, res) => {

const {prompt,apiKey} = req.query;

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
    }

    else if(keys[0].credits == 0){
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res.status(403).send("You have consumed your trial credits, your API key has been disabled.");
    }

   const response = await ai.models.generateContent({
    model: "gemini-2.0-flash-preview-image-generation",
    contents: prompt,
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });
for (const part of response.candidates[0].content.parts) {
    // Based on the part type, either show the text or save the image
    if (part.text) {
      console.log(part.text);
    } else if (part.inlineData) {
      const imageData = part.inlineData.data;
      const buffer = Buffer.from(imageData, "base64");
      fs.writeFileSync("gemini-native-image.png", buffer);
      res.sendFile("gemini-native-image.png", { root: __dirname });
    }
  }

await supabase
      .from("enabled_apis")
      .update({ credits: keys[0].credits - 1 })
      .eq("api_key", apiKey);

  } catch (error) {
    console.error(error);
    res.status(500).send("Something went wrong");
  }
});






app.post("/text", async (req, res) => {

const {prompt,apiKey} = req.query;

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
    }

    else if(keys[0].credits == 0){
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
    }

    else if(keys[0].credits == 0){
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res.status(403).send("You have consumed your trial credits, your API key has been disabled.");
    }
  

if(prompt.includes("image")){
  const imageresponse = await axios.post(`https://algoleap-api-console.onrender.com/image?prompt=${prompt}&apiKey=${apiKey}`);
  res.sendFile("image.png", { root: __dirname });
  return;
}
else if(prompt.includes("audio")){
  const audioresponse = await axios.post(`https://algoleap-api-console.onrender.com/audio?prompt=${prompt}&apiKey=${apiKey}`);
  res.send(audioresponse.data);
  return;
}
else{
  const textresponse = await axios.post(`https://algoleap-api-console.onrender.com/text?prompt=${prompt}&apiKey=${apiKey}`);
  res.send(textresponse.data);
  return;
}

await supabase
      .from("enabled_apis")
      .update({ credits: keys[0].credits - 1 })
      .eq("api_key", apiKey);

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
      callbackURL: "https://algoleap-api-console.onrender.com/auth/google/dashboard",
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
}
 else {
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

  async function saveWaveFile(
   filename,
   pcmData,
   channels = 1,
   rate = 24000,
   sampleWidth = 2,
) {
   return new Promise((resolve, reject) => {
      const writer = new wav.FileWriter(filename, {
            channels,
            sampleRate: rate,
            bitDepth: sampleWidth * 8,
      });

      writer.on('finish', resolve);
      writer.on('error', reject);

      writer.write(pcmData);
      writer.end();
   });
}

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
      return res.status(403).send("You have consumed your trial credits, your API key has been disabled.");
    }

    async function saveWaveFile(filename, pcmData, channels = 1, rate = 24000, sampleWidth = 2) {
      return new Promise((resolve, reject) => {
        const writer = new wav.FileWriter(filename, {
          channels,
          sampleRate: rate,
          bitDepth: sampleWidth * 8,
        });

        writer.on('finish', resolve);
        writer.on('error', reject);

        writer.write(pcmData);
        writer.end();
      });
    }

    async function main() {
      console.log("Calling Gemini API");
      const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      console.log("Gemini API response received");

      const data = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!data) throw new Error("No audio data returned from Gemini");

      const audioBuffer = Buffer.from(data, 'base64');
      const fileName = 'out.wav';
      await saveWaveFile(fileName, audioBuffer);
      console.log("Audio saved, sending file...");
      res.sendFile(fileName, { root: __dirname });
    }

    await main();

    await supabase
      .from("enabled_apis")
      .update({ credits: keys[0].credits - 1 })
      .eq("api_key", apiKey);
  } catch (error) {
    console.error("🔥 ERROR:", error);
    res.status(500).send("Something went wrong");
  }
});




app.post("/pay", async (req, res) => {
  const apiKey = req.body.apiKey; // Use body-parser middleware to parse req.body

  try {
    // Check if API key is valid
    const { data: keys, error: dbError } = await supabase
      .from("enabled_apis")
      .select("*")
      .eq("api_key", apiKey);

    if (dbError) {
      console.error(dbError);
      return res.status(500).send("Database error");
    }

    if (!keys || keys.length === 0) {
      return res.status(403).send("API key not found!");
    }

    if (keys[0].status !== "disabled") {
      return res.status(403).send("API key is already enabled. There are no dues to pay!");
    }

    // Create Razorpay order
    instance.orders.create(
      { amount: 500, currency: "INR" }, // 500.00 INR
      (err, order) => {
        if (err) {
          console.error("Razorpay error:", err);
          return res.status(500).send("Payment initiation failed");
        }

        // Send order details to client
        res.status(200).json(order);
      }
    );
  } catch (error) {
    console.error(error);
    res.status(500).send("Something went wrong");
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
