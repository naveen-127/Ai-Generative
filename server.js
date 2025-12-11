const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Increase server timeouts
app.use((req, res, next) => {
    req.setTimeout(300000); // 5 minutes
    res.setTimeout(300000);
    next();
});

// ✅ AWS S3 Configuration
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations-test-admin';
const S3_FOLDER_PATH = 'subtopics/';

// ✅ HeyGen API Configuration
const HYGEN_API_KEY = process.env.HYGEN_API_KEY;
const HYGEN_API_URL = process.env.HYGEN_API_URL || 'https://api.heygen.com';

if (!HYGEN_API_KEY) {
    console.warn("⚠️ HYGEN_API_KEY not found in .env file. HeyGen API calls will fail.");
} else {
    console.log(`🔑 HeyGen API Key configured: ${HYGEN_API_KEY.substring(0, 15)}...`);
}

// ✅ CORS configuration
const allowedOrigins = [
    "https://d3ty37mf4sf9cz.cloudfront.net",
    "http://100.31.100.74:3000",
    "http://localhost:3000",
    "https://majestic-frangollo-031fed.netlify.app",
    "https://classy-kulfi-cddfef.netlify.app",
    "http://localhost:5173",
    "http://localhost:5174",
    "https://padmasini7-frontend.netlify.app",
    "https://ai-generative-rhk1.onrender.com",
    "https://ai-generative-1.onrender.com"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        console.log("❌ CORS Blocked:", origin);
        return callback(new Error(`CORS policy violation`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ✅ MongoDB connection
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI in .env");
    process.exit(1);
}

const client = new MongoClient(MONGO_URI);

async function connectDB() {
    try {
        await client.connect();
        console.log("✅ Connected to MongoDB");
    } catch (err) {
        console.error("❌ MongoDB connection error:", err);
        process.exit(1);
    }
}

connectDB();

function getDB(dbname = "professional") {
    return client.db(dbname);
}

// ✅ Job status tracking
const jobStatus = new Map();

// ✅ FIXED: Simple Quick Response Endpoint
app.post("/generate-hygen-video", async (req, res) => {
    try {
        const {
            subtopic,
            description,
            questions = [],
            subtopicId,
            parentId,
            rootId,
            dbname = "professional",
            subjectName,
            avatar = "anna"
        } = req.body;

        console.log("\n🎬 [HEYGEN VIDEO GENERATION] Starting video generation:");
        console.log(`   📝 Subtopic: ${subtopic}`);
        console.log(`   🎯 Subtopic ID: ${subtopicId}`);
        console.log(`   📁 Database: ${dbname}`);

        // Generate job ID
        const jobId = `hygen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'queued',
            subtopic: subtopic,
            startedAt: new Date(),
            questions: questions.length,
            avatar: avatar,
            subtopicId: subtopicId,
            progress: 'Job queued for processing'
        });

        // IMMEDIATE RESPONSE
        res.json({
            success: true,
            status: "queued",
            message: "HeyGen AI video generation started in background",
            job_id: jobId,
            subtopic: subtopic,
            note: "Video will be processed in background. Use /api/job-status/:jobId to check progress.",
            estimated_time: "2-3 minutes"
        });

        // Start background processing
        setTimeout(() => {
            processHygenVideoJob(jobId, {
                subtopic,
                description,
                questions,
                subtopicId,
                parentId,
                rootId,
                dbname,
                subjectName,
                avatar
            });
        }, 100);

    } catch (err) {
        console.error("❌ Error starting HeyGen video generation:", err);
        res.status(500).json({ 
            success: false,
            error: "Failed to start video generation: " + err.message 
        });
    }
});

// ✅ FIXED: Update nested subtopic in units array
async function updateNestedSubtopicInUnits(collection, subtopicId, videoUrl) {
    console.log(`\n🔍 [DB UPDATE] Searching for subtopicId: ${subtopicId}`);
    
    try {
        let objectId;
        try {
            objectId = new ObjectId(subtopicId);
        } catch {
            objectId = subtopicId;
        }

        const queryStrategies = [
            { "units._id": objectId },
            { "units._id": subtopicId },
            { "_id": objectId },
            { "_id": subtopicId },
            { "units.id": subtopicId }
        ];

        let parentDoc = null;
        for (const query of queryStrategies) {
            console.log(`   🔍 Trying query:`, query);
            parentDoc = await collection.findOne(query);
            if (parentDoc) {
                console.log(`   ✅ Found document`);
                break;
            }
        }

        if (!parentDoc) {
            console.log(`   ❌ No document found for subtopicId: ${subtopicId}`);
            return { updated: false, message: "No parent document found" };
        }

        // Check if this is a main document
        if (parentDoc._id.toString() === subtopicId || parentDoc._id.equals?.(objectId) || parentDoc._id === subtopicId) {
            console.log(`   📝 Updating MAIN document`);
            const result = await collection.updateOne(
                { "_id": parentDoc._id },
                {
                    $set: {
                        aiVideoUrl: videoUrl,
                        updatedAt: new Date(),
                        videoStorage: "aws_s3",
                        s3Path: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.matchedCount > 0) {
                return { 
                    updated: true, 
                    location: "main_document",
                    collectionName: collection.collectionName
                };
            }
        }

        // Check if it's in units array
        if (parentDoc.units && Array.isArray(parentDoc.units)) {
            console.log(`   🔧 Updating in units array...`);
            const result = await collection.updateOne(
                { 
                    "_id": parentDoc._id,
                    "units._id": objectId
                },
                {
                    $set: {
                        "units.$.aiVideoUrl": videoUrl,
                        "units.$.updatedAt": new Date(),
                        "units.$.videoStorage": "aws_s3",
                        "units.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.matchedCount > 0) {
                return { 
                    updated: true, 
                    location: "nested_units_array",
                    collectionName: collection.collectionName
                };
            }
        }
        
        return { updated: false, message: "Could not update document" };
        
    } catch (error) {
        console.error(`   ❌ Error updating: ${error.message}`);
        return { updated: false, message: error.message };
    }
}

// ✅ AWS S3 Upload Function
async function uploadToS3(videoBuffer, filename) {
    try {
        console.log("\n☁️ [S3 UPLOAD] Starting S3 upload...");
        console.log(`   📁 Bucket: ${S3_BUCKET_NAME}`);
        console.log(`   📁 Folder: ${S3_FOLDER_PATH}`);
        console.log(`   📄 Filename: ${filename}`);

        const key = `${S3_FOLDER_PATH}${filename}`;
        console.log(`   🔑 S3 Key: ${key}`);
        
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: videoBuffer,
            ContentType: 'video/mp4',
            ACL: 'public-read'
        });

        await s3Client.send(command);
        console.log(`   ✅ Upload to S3 successful`);

        const region = process.env.AWS_REGION || 'ap-south-1';
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
        console.log(`   🔗 S3 Public URL: ${s3Url}`);

        return s3Url;
    } catch (error) {
        console.error(`   ❌ S3 upload failed: ${error.message}`);
        throw error;
    }
}

// ✅ Download video from URL
async function downloadVideo(videoUrl) {
    try {
        console.log(`   📥 Downloading video from: ${videoUrl}`);
        
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: {
                'Accept': 'video/*',
                'User-Agent': 'Mozilla/5.0'
            }
        });

        console.log(`   ✅ Video downloaded, size: ${response.data.length} bytes`);
        return response.data;
    } catch (error) {
        console.error(`   ❌ Video download failed: ${error.message}`);
        throw error;
    }
}

// ✅ SIMPLIFIED: HeyGen V1 API Video Generation
async function generateHygenVideo(script, subtopic, avatar = "anna") {
    try {
        if (!HYGEN_API_KEY) {
            throw new Error("HeyGen API key is not configured");
        }

        console.log("\n🎬 [HEYGEN V1 API] Generating video...");
        console.log(`   📝 Subtopic: ${subtopic}`);
        console.log(`   🔑 API Key: ${HYGEN_API_KEY.substring(0, 15)}...`);
        
        // Clean and truncate script for free tier
        let cleanScript = script.replace(/<[^>]*>/g, '');
        
        // Free tier has strict limits - keep it very short
        if (cleanScript.length > 150) {
            console.log(`   ⚠️ Script too long for free tier, truncating to 150 chars`);
            cleanScript = cleanScript.substring(0, 150) + "...";
        }
        
        console.log(`   📏 Script length: ${cleanScript.length} characters`);

        // V1 API REQUEST BODY - Simple and minimal
        const requestData = {
            video_inputs: [{
                character: {
                    type: "avatar",
                    avatar_id: "anna", // Free tier usually only supports "anna"
                    avatar_style: "normal"
                },
                voice: {
                    type: "text",
                    input_text: cleanScript,
                    voice_id: "1bd001e7e50f421d891986aad5158bc8" // Default English voice
                }
            }],
            aspect_ratio: "16:9",
            caption: false,
            test: true,  // MUST BE TRUE for free tier
            quality: "low" // Free tier only allows low quality
        };

        console.log("📤 Sending V1 API request...");
        console.log("   Endpoint: POST /v1/video/generate");
        console.log("   Avatar: anna (free tier default)");
        console.log("   Test mode: true (required)");
        console.log("   Quality: low (required)");

        // Make the API call
        const response = await axios.post(
            'https://api.heygen.com/v1/video/generate',
            requestData,
            {
                headers: {
                    'X-Api-Key': HYGEN_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 120000, // 2 minutes
                validateStatus: function (status) {
                    return status < 500; // Don't throw on 4xx errors
                }
            }
        );

        console.log(`📥 Response status: ${response.status}`);

        if (response.status === 200 || response.status === 201) {
            console.log("✅ V1 API call successful!");
            
            // Log response for debugging
            console.log("📊 Response:", JSON.stringify(response.data, null, 2));
            
            // Extract video ID
            let videoId = null;
            
            if (response.data.data?.video_id) {
                videoId = response.data.data.video_id;
            } else if (response.data.video_id) {
                videoId = response.data.video_id;
            } else if (response.data.id) {
                videoId = response.data.id;
            }
            
            if (videoId) {
                console.log(`🎉 Video ID: ${videoId}`);
                return videoId;
            } else {
                console.log("⚠️ No video_id found in response");
                throw new Error("No video ID in API response");
            }
            
        } else if (response.status === 402) {
            console.log("❌ Payment required (402):", response.data);
            throw new Error("Payment required. Your free plan doesn't include API access or credits are exhausted.");
            
        } else if (response.status === 403) {
            console.log("❌ Forbidden (403):", response.data);
            throw new Error("API access forbidden. Free plan may not include API access.");
            
        } else if (response.status === 404) {
            console.log("❌ Not found (404):", response.data);
            throw new Error("V1 API endpoint not found. Your account may not have API access enabled.");
            
        } else if (response.status === 429) {
            console.log("❌ Rate limit (429):", response.data);
            throw new Error("Rate limit exceeded. Wait before trying again.");
            
        } else {
            console.log(`⚠️ Unexpected status ${response.status}:`, response.data);
            throw new Error(`API returned status ${response.status}`);
        }

    } catch (error) {
        console.error("\n❌ HeyGen V1 API Error:");
        console.error("Message:", error.message);
        
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", error.response.data);
            
            // If it's a 402 or 403 error, provide clear instructions
            if (error.response.status === 402 || error.response.status === 403) {
                throw new Error(`Your HeyGen Free plan (10 credits) doesn't include API access.

💡 What to do:
1. Use manual workflow (create video at https://app.heygen.com/studio)
2. Upgrade to Creator plan ($29/month) for API access
3. Contact support@heygen.com`);
            }
        }
        
        throw error;
    }
}

// ✅ SIMPLIFIED: Poll HeyGen video status (V1 only)
async function pollHygenVideoStatus(videoId, jobId) {
    const MAX_POLLS = 60; // 10 minutes max (poll every 10 seconds)
    let pollCount = 0;
    
    console.log(`⏳ Polling HeyGen video status for: ${videoId}`);
    
    while (pollCount < MAX_POLLS) {
        await new Promise(r => setTimeout(r, 10000)); // Poll every 10 seconds
        pollCount++;
        
        // Update job status
        if (jobStatus.has(jobId)) {
            jobStatus.set(jobId, {
                ...jobStatus.get(jobId),
                progress: `Checking status (${pollCount}/${MAX_POLLS})`,
                polls: pollCount
            });
        }
        
        try {
            console.log(`📊 Poll ${pollCount}/${MAX_POLLS}: Checking video status...`);
            
            const response = await axios.get(
                `https://api.heygen.com/v1/video_status/get?video_id=${videoId}`,
                {
                    headers: { 'X-Api-Key': HYGEN_API_KEY },
                    timeout: 30000
                }
            );
            
            if (response.data.data) {
                const status = response.data.data.status;
                console.log(`📈 Status: ${status}`);
                
                if (status === "completed") {
                    const videoUrl = response.data.data.video_url;
                    if (videoUrl) {
                        console.log(`✅ Video ready: ${videoUrl}`);
                        return videoUrl;
                    }
                } else if (status === "failed") {
                    throw new Error("Video generation failed on HeyGen side");
                } else if (status === "processing") {
                    console.log("⏳ Still processing...");
                }
            }
            
        } catch (error) {
            console.log(`⚠️ Poll ${pollCount} failed: ${error.message}`);
        }
    }
    
    throw new Error(`Polling timeout after ${MAX_POLLS} attempts (10 minutes)`);
}

// ✅ SIMPLIFIED: Background Job Processing
async function processHygenVideoJob(jobId, params) {
    const { subtopic, description, questions, subtopicId, dbname, subjectName, avatar } = params;
    
    try {
        console.log(`\n🔄 [JOB ${jobId}] Processing HeyGen video for: ${subtopic}`);
        
        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'processing',
            progress: 'Preparing script...'
        });

        // Prepare script
        let cleanScript = description.replace(/<[^>]*>/g, '');
        
        if (questions.length > 0) {
            cleanScript += "\n\nNow, let me ask you some questions to test your understanding.";
            questions.forEach((q, index) => {
                cleanScript += ` Question ${index + 1}: ${q.question}. The correct answer is: ${q.answer}.`;
            });
        }

        console.log(`📝 Script prepared: ${cleanScript.length} characters`);

        // Step 1: Generate video with HeyGen V1 API
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Calling HeyGen V1 API...'
        });

        const videoId = await generateHygenVideo(cleanScript, subtopic, avatar);
        
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            videoId: videoId,
            progress: 'Waiting for video to render...'
        });

        // Step 2: Poll for video completion
        const hygenVideoUrl = await pollHygenVideoStatus(videoId, jobId);
        
        if (!hygenVideoUrl) {
            throw new Error("No video URL returned from HeyGen");
        }

        console.log(`✅ HeyGen video generated: ${hygenVideoUrl}`);

        // Step 3: Download and upload to S3
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Downloading video from HeyGen...'
        });

        console.log("\n☁️ Starting S3 upload process...");
        
        // Generate unique filename
        const timestamp = Date.now();
        const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const filename = `hygen_video_${safeSubtopicName}_${timestamp}.mp4`;

        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Uploading to AWS S3...'
        });

        try {
            // Download video from HeyGen
            const videoBuffer = await downloadVideo(hygenVideoUrl);
            
            // Upload to S3
            const s3Url = await uploadToS3(videoBuffer, filename);
            console.log(`✅ S3 Upload successful: ${s3Url}`);

            // Step 4: Save to database
            jobStatus.set(jobId, {
                ...jobStatus.get(jobId),
                progress: 'Saving to database...'
            });

            if (s3Url && subtopicId) {
                console.log("\n💾 Saving S3 URL to database...");
                
                const dbConn = getDB(dbname);
                let targetCollections;
                
                if (subjectName) {
                    targetCollections = [subjectName];
                    console.log(`🔍 Using specific collection: ${subjectName}`);
                } else {
                    const collections = await dbConn.listCollections().toArray();
                    targetCollections = collections.map(c => c.name);
                    console.log(`🔍 Searching in ALL collections: ${targetCollections.join(', ')}`);
                }

                let updated = false;
                let updateLocation = "not_found";
                let updatedCollection = "unknown";

                for (const collectionName of targetCollections) {
                    console.log(`\n🔍 Processing collection: ${collectionName}`);
                    const collection = dbConn.collection(collectionName);
                    const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, s3Url);
                    if (updateResult.updated) {
                        updated = true;
                        updateLocation = updateResult.location;
                        updatedCollection = updateResult.collectionName || collectionName;
                        console.log(`✅ SUCCESS in ${updatedCollection} at ${updateLocation}`);
                        break;
                    }
                }

                if (updated) {
                    console.log(`🎉 S3 URL saved to database in ${updatedCollection} at ${updateLocation}`);
                    
                    jobStatus.set(jobId, {
                        status: 'completed',
                        subtopic: subtopic,
                        videoUrl: s3Url,
                        s3Url: s3Url,
                        completedAt: new Date(),
                        questions: questions.length,
                        avatar: avatar,
                        storedIn: 'aws_s3',
                        databaseUpdated: true,
                        updateLocation: updateLocation,
                        collection: updatedCollection,
                        message: 'HeyGen video uploaded to S3 and saved to database successfully'
                    });
                    
                    console.log("✅ PROCESS COMPLETE: HeyGen video saved to S3 and database!");
                } else {
                    console.log("\n⚠️ COULD NOT SAVE TO DATABASE!");
                    console.log(`   Subtopic ID: ${subtopicId}`);
                    console.log(`   Database: ${dbname}`);
                    
                    jobStatus.set(jobId, {
                        status: 'completed',
                        subtopic: subtopic,
                        videoUrl: s3Url,
                        s3Url: s3Url,
                        completedAt: new Date(),
                        questions: questions.length,
                        avatar: avatar,
                        storedIn: 'aws_s3',
                        databaseUpdated: false,
                        note: 'Subtopic not found in database',
                        s3UrlForManualSave: s3Url,
                        subtopicIdForManualSave: subtopicId
                    });
                }
            } else {
                throw new Error("Missing S3 URL or subtopic ID");
            }

        } catch (uploadError) {
            console.error("❌ S3 upload failed:", uploadError);
            
            // If S3 upload fails, still mark as completed with HeyGen URL
            jobStatus.set(jobId, {
                status: 'completed',
                subtopic: subtopic,
                videoUrl: hygenVideoUrl,
                s3Url: null,
                completedAt: new Date(),
                questions: questions.length,
                avatar: avatar,
                storedIn: 'hygen_only',
                databaseUpdated: false,
                note: 'Video generated but S3 upload failed. Using HeyGen URL directly.',
                error: uploadError.message
            });
        }

    } catch (error) {
        console.error("❌ HeyGen video generation failed:", error);
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'failed',
            error: error.message,
            failedAt: new Date(),
            progress: `Failed: ${error.message}`
        });
    }
}

// ✅ Job Status Endpoint
app.get("/api/job-status/:jobId", (req, res) => {
    try {
        const { jobId } = req.params;
        const status = jobStatus.get(jobId);

        if (!status) {
            return res.status(404).json({
                success: false,
                error: "Job not found",
                jobId: jobId
            });
        }

        res.json({
            success: true,
            ...status,
            jobId: jobId,
            elapsed: status.startedAt ? (new Date() - new Date(status.startedAt)) / 1000 : 0
        });
    } catch (error) {
        console.error("❌ Job status check failed:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to check job status" 
        });
    }
});

// ✅ Manual Save Endpoint
app.post("/api/save-to-db", async (req, res) => {
    try {
        const {
            videoUrl,
            subtopic,
            subtopicId,
            dbname = "professional",
            subjectName
        } = req.body;

        console.log("\n📤 [MANUAL SAVE] Manual save request");

        if (!videoUrl || !subtopicId) {
            return res.status(400).json({
                success: false,
                error: "Missing videoUrl or subtopicId"
            });
        }

        const dbConn = getDB(dbname);
        let targetCollections;
        
        if (subjectName) {
            targetCollections = [subjectName];
        } else {
            const collections = await dbConn.listCollections().toArray();
            targetCollections = collections.map(c => c.name);
        }

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, videoUrl);
            if (updateResult.updated) {
                updated = true;
                updateLocation = updateResult.location;
                updatedCollection = collectionName;
                break;
            }
        }

        if (updated) {
            res.json({
                success: true,
                s3_url: videoUrl,
                stored_in: "database",
                database_updated: true,
                location: updateLocation,
                collection: updatedCollection,
                message: `S3 URL saved to database successfully in ${updatedCollection}`
            });
        } else {
            res.json({
                success: false,
                s3_url: videoUrl,
                stored_in: "s3_only",
                database_updated: false,
                message: "S3 URL NOT saved to database - subtopic not found"
            });
        }

    } catch (error) {
        console.error("❌ Manual save failed:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ Manual Video Workflow (for free tier without API access)
app.post("/api/manual-video-workflow", async (req, res) => {
    try {
        const {
            videoUrl,
            subtopic,
            subtopicId,
            dbname = "professional",
            subjectName
        } = req.body;

        console.log("\n📋 [MANUAL WORKFLOW] Processing manual video");

        if (!videoUrl || !subtopicId) {
            return res.status(400).json({
                success: false,
                error: "Missing videoUrl or subtopicId",
                instructions: "1. Create video at https://app.heygen.com/studio, 2. Copy video URL, 3. Paste here"
            });
        }

        // Generate job ID
        const jobId = `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'processing',
            subtopic: subtopic,
            startedAt: new Date(),
            progress: 'Processing manual video...',
            workflow: 'manual'
        });

        // Immediate response
        res.json({
            success: true,
            status: "processing",
            job_id: jobId,
            message: "Manual video workflow started"
        });

        // Process in background
        setTimeout(async () => {
            try {
                let finalVideoUrl = videoUrl;
                
                // Try to download and upload to S3
                let s3Url = null;
                try {
                    console.log("☁️ Attempting to upload to S3...");
                    const videoBuffer = await downloadVideo(finalVideoUrl);
                    const timestamp = Date.now();
                    const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
                    const filename = `manual_video_${safeSubtopicName}_${timestamp}.mp4`;
                    
                    s3Url = await uploadToS3(videoBuffer, filename);
                    console.log(`✅ Uploaded to S3: ${s3Url}`);
                    finalVideoUrl = s3Url;
                } catch (uploadError) {
                    console.log("⚠️ S3 upload failed, using original URL:", uploadError.message);
                }

                // Save to database
                let databaseUpdated = false;
                let updateLocation = "not_found";
                let updatedCollection = "unknown";

                if (subtopicId && finalVideoUrl) {
                    const dbConn = getDB(dbname);
                    let targetCollections = subjectName ? [subjectName] : 
                        (await dbConn.listCollections().toArray()).map(c => c.name);
                    
                    for (const collectionName of targetCollections) {
                        const collection = dbConn.collection(collectionName);
                        const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, finalVideoUrl);
                        if (updateResult.updated) {
                            databaseUpdated = true;
                            updateLocation = updateResult.location;
                            updatedCollection = collectionName;
                            break;
                        }
                    }
                }

                // Update job status
                jobStatus.set(jobId, {
                    status: 'completed',
                    subtopic: subtopic,
                    videoUrl: finalVideoUrl,
                    s3Url: finalVideoUrl.includes('amazonaws.com') ? finalVideoUrl : null,
                    completedAt: new Date(),
                    storedIn: finalVideoUrl.includes('amazonaws.com') ? 'aws_s3' : 'original_url',
                    databaseUpdated: databaseUpdated,
                    updateLocation: updateLocation,
                    collection: updatedCollection,
                    workflow: 'manual',
                    message: databaseUpdated 
                        ? 'Manual video saved to database successfully' 
                        : 'Video processed but not saved to database'
                });

                console.log("✅ Manual workflow completed");

            } catch (error) {
                console.error("❌ Manual workflow failed:", error);
                jobStatus.set(jobId, {
                    status: 'failed',
                    error: error.message,
                    failedAt: new Date(),
                    progress: 'Failed'
                });
            }
        }, 100);

    } catch (err) {
        console.error("❌ Manual workflow error:", err);
        res.status(500).json({ 
            success: false,
            error: err.message 
        });
    }
});

// ✅ Simple API Test (V1 only)
app.get("/api/test-api", async (req, res) => {
    try {
        console.log("\n🔍 Testing HeyGen V1 API...");
        
        if (!HYGEN_API_KEY) {
            return res.json({
                success: false,
                error: "No API key in .env file"
            });
        }
        
        // Simple ping test
        try {
            const response = await axios.get('https://api.heygen.com/v1/ping', {
                headers: { 'X-Api-Key': HYGEN_API_KEY },
                timeout: 5000
            });
            
            res.json({
                success: true,
                message: "✅ HeyGen V1 API is accessible",
                status: response.status,
                data: response.data,
                note: "If you see '0 Requests That Month' in docs, your free plan may not include API access"
            });
            
        } catch (error) {
            res.json({
                success: false,
                error: `V1 API test failed: ${error.message}`,
                status: error.response?.status,
                details: error.response?.data,
                solution: [
                    "Your free plan (10 credits) likely doesn't include API access",
                    "Use /api/manual-video-workflow endpoint instead",
                    "Or upgrade to Creator plan ($29/month)"
                ]
            });
        }
        
    } catch (error) {
        console.error("❌ API test failed:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ Free Tier Info
app.get("/api/free-tier-info", (req, res) => {
    res.json({
        success: true,
        plan: "HeyGen Free",
        credits: "10 credits remaining",
        apiAccess: "Likely NOT included in free plan",
        evidence: [
            "V2 API returns 404 (not found)",
            "Your API docs show '0 Requests That Month'",
            "Free plans usually don't include API access"
        ],
        recommendations: [
            {
                title: "Manual Workflow",
                description: "Use web interface + upload",
                steps: [
                    "1. Create video at https://app.heygen.com/studio",
                    "2. Download or copy video URL",
                    "3. Use /api/manual-video-workflow endpoint"
                ],
                endpoint: "POST /api/manual-video-workflow"
            },
            {
                title: "Upgrade Plan",
                description: "Get Creator plan for API access",
                cost: "$29/month",
                url: "https://app.heygen.com/pricing"
            },
            {
                title: "Contact Support",
                description: "Ask about free tier API access",
                email: "support@heygen.com"
            }
        ]
    });
});

// ✅ DEBUG endpoints
app.get("/api/debug-collections", async (req, res) => {
    try {
        const { dbname = "professional" } = req.query;
        const dbConn = getDB(dbname);
        const collections = await dbConn.listCollections().toArray();
        
        res.json({
            success: true,
            database: dbname,
            collections: collections.map(c => c.name),
            count: collections.length
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

app.get("/api/debug-find-doc", async (req, res) => {
    try {
        const { 
            subtopicId, 
            dbname = "professional",
            collectionName 
        } = req.query;

        const dbConn = getDB(dbname);
        
        if (collectionName) {
            const collection = dbConn.collection(collectionName);
            const doc = await collection.findOne({
                $or: [
                    { "_id": new ObjectId(subtopicId) },
                    { "_id": subtopicId },
                    { "units._id": new ObjectId(subtopicId) },
                    { "units._id": subtopicId },
                    { "units.id": subtopicId }
                ]
            });
            
            res.json({
                success: true,
                found: !!doc,
                collection: collectionName,
                document: doc
            });
        } else {
            const collections = await dbConn.listCollections().toArray();
            let foundDoc = null;
            let foundCollection = "";
            
            for (const coll of collections) {
                const collection = dbConn.collection(coll.name);
                const doc = await collection.findOne({
                    $or: [
                        { "_id": new ObjectId(subtopicId) },
                        { "_id": subtopicId },
                        { "units._id": new ObjectId(subtopicId) },
                        { "units._id": subtopicId },
                        { "units.id": subtopicId }
                    ]
                });
                
                if (doc) {
                    foundDoc = doc;
                    foundCollection = coll.name;
                    break;
                }
            }
            
            res.json({
                success: true,
                found: !!foundDoc,
                collection: foundCollection,
                document: foundDoc
            });
        }

    } catch (err) {
        res.status(500).json({ 
            success: false,
            error: err.message 
        });
    }
});

// ✅ Clear old jobs
function cleanupOldJobs() {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    for (const [jobId, job] of jobStatus.entries()) {
        if (job.startedAt && new Date(job.startedAt).getTime() < twentyFourHoursAgo) {
            jobStatus.delete(jobId);
        }
    }
}

// ✅ Health check
app.get("/health", (req, res) => {
    cleanupOldJobs();
    
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "HeyGen AI Video Generator with S3 Storage",
        active_jobs: jobStatus.size,
        endpoints: [
            "POST /generate-hygen-video (V1 API)",
            "POST /api/manual-video-workflow (For free tier)",
            "POST /api/save-to-db",
            "GET /api/job-status/:jobId",
            "GET /api/test-api (Test API access)",
            "GET /api/free-tier-info (Free plan help)",
            "GET /api/debug-collections",
            "GET /api/debug-find-doc",
            "GET /health"
        ],
        s3: {
            bucket: S3_BUCKET_NAME,
            folder: S3_FOLDER_PATH,
            region: process.env.AWS_REGION || 'ap-south-1'
        },
        hygen: {
            configured: !!HYGEN_API_KEY,
            apiKeyPrefix: HYGEN_API_KEY ? HYGEN_API_KEY.substring(0, 15) + '...' : 'Not set',
            note: "Free plan (10 credits) may not include API access"
        }
    });
});

// ✅ Start server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ Server running on http://0.0.0.0:${PORT}`);
    console.log(`☁️ AWS S3 Configuration:`);
    console.log(`   Bucket: ${S3_BUCKET_NAME}`);
    console.log(`   Folder: ${S3_FOLDER_PATH}`);
    console.log(`   Region: ${process.env.AWS_REGION || 'ap-south-1'}`);
    console.log(`🤖 HeyGen API: ${HYGEN_API_KEY ? 'Configured' : 'Not configured'}`);
    if (HYGEN_API_KEY) {
        console.log(`   API Key: ${HYGEN_API_KEY.substring(0, 15)}...`);
        console.log(`   ⚠️  Note: Your free plan may not include API access`);
        console.log(`   💡 Use /api/manual-video-workflow for manual uploads`);
    }
    console.log(`\n✅ Available Endpoints:`);
    console.log(`   POST /generate-hygen-video (Try V1 API)`);
    console.log(`   POST /api/manual-video-workflow (Manual upload)`);
    console.log(`   POST /api/save-to-db`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   GET /api/test-api (Test API)`);
    console.log(`   GET /api/free-tier-info (Help for free plan)`);
    console.log(`   GET /health`);
});
