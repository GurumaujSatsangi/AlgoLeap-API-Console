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
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import wav from "wav";
import { createWriteStream } from "fs";
import fs from "fs";
import { Readable } from "stream";
import { ElevenLabsClient, stream } from '@elevenlabs/elevenlabs-js';

import NodeCache from "node-cache";

const app = express();
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});



const instance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const localCache = new NodeCache({ stdTTL: 1 }); // 5 min TTL

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
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
  const message = req.query.message || null;

  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const uid = req.user.uid;
  const cacheKey = `dashboard:${uid}`;

  try {
    const cached = localCache.get(cacheKey);

    if (cached) {
      const { enabledApis, history, transaction } = cached;
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

    localCache.set(cacheKey, { enabledApis, history, transaction });

    res.render("dashboard", {
      user: req.user,
      enabledApis,
      textOutput: null,
      message,
      history,
      transaction,
    });
  } catch (err) {
    console.error("Cache/DB error:", err);
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
    if (!req.isAuthenticated()) {
      return res.redirect("/");
    }

    const uid = req.user.uid;
    const cacheKey = `dashboard:${uid}`;
    const message = req.query.message || null;

    try {
      const cached = localCache.get(cacheKey);

      if (cached) {
        const { enabledApis, history, transaction } = cached;
        return res.render("dashboard.ejs", {
          user: req.user,
          enabledApis,
          textOutput: null,
          message,
          history,
          transaction,
        });
      }

      const { data: apiData, error } = await supabase
        .from("enabled_apis")
        .select("*")
        .eq("uid", uid)
        .single();

      if (error && error.code !== "PGRST116") {
        console.error(error);
        return res.send("Database error!");
      }

      const enabledApis = apiData ? [apiData] : [];

      const { data: history, error: historyError } = await supabase
        .from("prompt_history")
        .select("*")
        .eq("api_key", enabledApis[0]?.api_key);

      const { data: transaction, error: transactionError } = await supabase
        .from("transaction_history")
        .select("*")
        .eq("uid", uid);

      localCache.set(cacheKey, { enabledApis, history, transaction });

      res.render("dashboard.ejs", {
        user: req.user,
        enabledApis,
        textOutput: null,
        message,
        history,
        transaction,
      });
    } catch (err) {
      console.error("Error:", err);
      res.status(500).send("Server error");
    }
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
      return res.redirect("/dashboard?message=Error fetching existing API keys.");
    }
    if (existingKeys.length > 0) {
      return res.redirect("/dashboard?message=You already have an API Key.");
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
      return res.render("dashboard", { message: "Error creating API key." });
    }

    return res.redirect("/dashboard");
     } catch (err) {
    console.error(err);
    return res.redirect("/dashboard?message=Error generating API key.");
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
        amount: 100000,
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

app.post("/genai", async (req, res) => {
  const { prompt, apiKey, speaker1, speaker2, voice1, voice2, voice } = req.query;

  if (!prompt || !apiKey) {
    return res.status(400).send("Missing prompt or API key");
  }

  try {
    // Use cached API key validation if available
    let keyData = localCache.get(apiKey);

    if (!keyData) {
      const { data: keys, error: dbError } = await supabase
        .from("enabled_apis")
        .select("*")
        .eq("api_key", apiKey);

      if (!keys || keys.length === 0) {
        return res.status(403).send("API key not found!");
      }

      keyData = keys[0];
      localCache.set(apiKey, keyData);
    }

    if (keyData.credits <= 0) {
      await supabase
        .from("enabled_apis")
        .update({ status: "disabled" })
        .eq("api_key", apiKey);
      return res.status(403).send("Trial credits consumed, API key disabled.");
    }

    const updateCredits = async () => {
      const newCredits = keyData.credits - 1;
      keyData.credits = newCredits;
      localCache.set(apiKey, keyData);
      await supabase
        .from("enabled_apis")
        .update({ credits: newCredits })
        .eq("api_key", apiKey);
    };

    const logPrompt = async (type, responseUrlOrText) => {
      await supabase.from("prompt_history").insert({
        api_key: apiKey,
        type,
        prompt,
        response: responseUrlOrText,
      });
    };

    if (prompt.includes("image")) {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash-preview-image-generation",
        contents: prompt,
        config: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      });

      const imageData = response?.candidates?.[0]?.content?.parts?.find(
        (p) => p.inlineData
      )?.inlineData?.data;

      if (!imageData) return res.status(500).send("Image generation failed");

      const buffer = Buffer.from(imageData, "base64");
      const fileName = `${crypto.randomUUID()}.png`;
      const imagePath = path.join(__dirname, fileName);
      fs.writeFileSync(imagePath, buffer);

      const uploadResult = await cloudinary.uploader.upload(imagePath, {
        resource_type: "image",
        public_id: fileName,
      });

      await logPrompt("image", uploadResult.secure_url);
      await updateCredits();

      return res.send({ url: uploadResult.secure_url });
    }

    if (prompt.includes("TTS") || prompt.includes("audio")) {
  const fileName = `${crypto.randomUUID()}.wav`;
  const audioPath = path.join(__dirname, fileName);

  const saveWaveFile = (
    filename,
    pcmData,
    channels = 1,
    rate = 24000,
    sampleWidth = 2
  ) => {
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
  };

  let response; 
  if (prompt.includes("conversation between")) {
    response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: speaker1,
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voice1 },
                },
              },
              {
                speaker: speaker2,
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voice2 },
                },
              },
            ],
          },
        },
      },
    });
  } else {
    response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice || "Kore"},
          },
        },
      },
    });
  }

  const data =
    response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) return res.status(500).send("Audio generation failed");

  await saveWaveFile(audioPath, Buffer.from(data, "base64"));

  try {
    const uploadResult = await cloudinary.uploader.upload(audioPath, {
      resource_type: "video",
      public_id: fileName,
    });

    // Remove local file after upload
    fs.unlink(audioPath, () => {});

    await logPrompt("audio", uploadResult.secure_url);
    await updateCredits();

    return res.send({
      message: "Audio generated",
      url: uploadResult.secure_url,
    });
  } catch (err) {
    fs.unlink(audioPath, () => {});
    return res.status(500).send("Audio upload failed");
  }
}

if (prompt.includes("music")) {
  try {
    // Generate music audio (returns a ReadableStream)
    const audioStream = await elevenlabs.textToSoundEffects.convert({
      text: prompt,
    });

    // Save to a file
    const fileName = `${crypto.randomUUID()}.wav`;
    const audioPath = path.join(__dirname, fileName);
    const writer = fs.createWriteStream(audioPath);
    await new Promise((resolve, reject) => {
      Readable.fromWeb(audioStream)
  .pipe(writer)
  .on("finish", resolve)
  .on("error", reject);
    });

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(audioPath, {
      resource_type: "video", // or "audio" if your Cloudinary plan supports it
      public_id: fileName,
    });

    // Remove local file after upload
    fs.unlink(audioPath, () => {});

    await logPrompt("music", uploadResult.secure_url);
    await updateCredits();

    return res.send({
      message: "Music generated",
      url: uploadResult.secure_url,
    });
  } catch (err) {
    console.error("Music block error:", err);
    return res.status(500).send("Music generation failed");
  }
}



    if (prompt.includes("video")) {
      let operation = await ai.models.generateVideos({
        model: "veo-2.0-generate-001",
        prompt: prompt,
        config: {
          personGeneration: "dont_allow",
          aspectRatio: "16:9",
        },
      });

      while (!operation.done) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        operation = await ai.operations.getVideosOperation({
          operation,
        });
      }

      const generatedVideo = operation.response?.generatedVideos?.[0];
      const videoUrl = `${generatedVideo?.video?.uri}&key=${process.env.GOOGLE_API_KEY}`;

      const resp = await fetch(videoUrl);
      const fileName = `${crypto.randomUUID()}.mp4`;
      const videoPath = path.join(__dirname, fileName);
      const writer = createWriteStream(videoPath);
      await new Promise((resolve, reject) => {
        Readable.fromWeb(resp.body)
          .pipe(writer)
          .on("finish", resolve)
          .on("error", reject);
      });
      const uploadResult = await cloudinary.uploader.upload(videoPath, {
        resource_type: "video",
        public_id: fileName,
      });

      await logPrompt("video", uploadResult.secure_url);
      await updateCredits();

      return res.send({
        message: "Video generated",
        url: uploadResult.secure_url,
      });
    }


    
    // Default: Text Generation
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    const textOutput =
      response?.text || response?.content || "No response text";

    await logPrompt("text", textOutput);
    await updateCredits();

    return res.send(textOutput);
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
      callbackURL: "http://localhost:3000/auth/google/dashboard",
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
