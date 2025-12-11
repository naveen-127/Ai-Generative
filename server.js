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

// ✅ CORRECT V2 API: Generate Avatar Video (from your documentation)
async function generateHygenVideo(script, subtopic, avatar = "anna") {
    try {
        if (!HYGEN_API_KEY) {
            throw new Error("HeyGen API key is not configured");
        }

        console.log("\n🎬 [HEYGEN V2 API] Generating Avatar Video...");
        console.log(`   📝 Subtopic: ${subtopic}`);
        console.log(`   📏 Script length: ${script.length} characters`);
        console.log(`   🔑 API Key: ${HYGEN_API_KEY.substring(0, 15)}...`);
        console.log(`   🌐 Endpoint: POST /v2/video/generate`);
        
        // Check script length for free tier
        let cleanScript = script.replace(/<[^>]*>/g, '');
        if (cleanScript.length > 300) {
            console.log(`   ⚠️ Script too long, truncating to 300 chars for free tier`);
            cleanScript = cleanScript.substring(0, 300) + "...";
        }
        
        console.log(`   📝 Final script: ${cleanScript.length} characters`);

        // CORRECT V2 API REQUEST BODY (from documentation)
        const requestData = {
            video_inputs: [{
                character: {
                    type: "avatar",
                    avatar_id: avatar, // Use the avatar parameter
                    avatar_style: "normal"
                },
                voice: {
                    type: "text",
                    input_text: cleanScript,
                    voice_id: "1bd001e7e50f421d891986aad5158bc8" // Default English voice
                },
                background: {
                    type: "color",
                    value: "#FFFFFF"
                }
            }],
            aspect_ratio: "16:9",
            caption: false,
            test: true  // IMPORTANT: For free tier/testing
        };

        console.log("📤 Sending V2 API request...");
        console.log("   Avatar ID:", avatar);
        console.log("   Test mode:", true);
        console.log("   Voice ID:", requestData.video_inputs[0].voice.voice_id);

        // Make the API call to EXACT endpoint from documentation
        const response = await axios.post(
            'https://api.heygen.com/v2/video/generate',
            requestData,
            {
                headers: {
                    'X-Api-Key': HYGEN_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'HeyGen-API-Client/1.0'
                },
                timeout: 120000, // 2 minutes timeout
                validateStatus: function (status) {
                    // Don't throw on 4xx errors so we can handle them
                    return status < 500;
                }
            }
        );

        console.log(`📥 Response status: ${response.status}`);
        console.log("📊 Response headers:", response.headers);

        // Handle different response statuses
        if (response.status === 200 || response.status === 201) {
            console.log("✅ V2 API call successful!");
            
            // Log the full response for debugging
            console.log("📄 Full response:", JSON.stringify(response.data, null, 2));
            
            // Extract video ID from V2 response structure
            let videoId = null;
            let videoUrl = null;
            
            // Try different response structures
            if (response.data.data) {
                if (response.data.data.video_id) {
                    videoId = response.data.data.video_id;
                }
                if (response.data.data.video_url) {
                    videoUrl = response.data.data.video_url;
                }
                if (response.data.data.id) {
                    videoId = response.data.data.id;
                }
            }
            
            // Also check root level
            if (!videoId && response.data.video_id) {
                videoId = response.data.video_id;
            }
            if (!videoUrl && response.data.video_url) {
                videoUrl = response.data.video_url;
            }
            if (!videoId && response.data.id) {
                videoId = response.data.id;
            }
            
            if (videoId) {
                console.log(`🎉 Video ID obtained: ${videoId}`);
                if (videoUrl) {
                    console.log(`🔗 Video URL: ${videoUrl}`);
                }
                return videoId;
            } else {
                console.log("⚠️ No video_id found in response. Available keys:");
                console.log(Object.keys(response.data));
                
                // If we got a successful response but no video_id, maybe it's in a different format
                // Return the first available ID
                const findAnyId = (obj) => {
                    for (const key in obj) {
                        if (key.toLowerCase().includes('id')) {
                            return obj[key];
                        }
                        if (typeof obj[key] === 'object') {
                            const found = findAnyId(obj[key]);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                
                const anyId = findAnyId(response.data);
                if (anyId) {
                    console.log(`🔍 Using found ID: ${anyId}`);
                    return anyId;
                }
                
                throw new Error("Success response but no video ID found");
            }
            
        } else if (response.status === 400) {
            console.log("❌ Bad request (400):", response.data);
            throw new Error(`Bad request: ${response.data.message || 'Check request parameters'}`);
            
        } else if (response.status === 401) {
            console.log("❌ Unauthorized (401):", response.data);
            throw new Error("API key is invalid or expired. Get a new one from HeyGen dashboard.");
            
        } else if (response.status === 402) {
            console.log("❌ Payment required (402):", response.data);
            throw new Error("Payment required. Free plan may not have API access or credits are exhausted.");
            
        } else if (response.status === 403) {
            console.log("❌ Forbidden (403):", response.data);
            throw new Error("API access forbidden. Your plan may not include V2 API access.");
            
        } else if (response.status === 404) {
            console.log("❌ Not found (404):", response.data);
            throw new Error("V2 API endpoint not found. Try V1 API or check if API is enabled for your account.");
            
        } else if (response.status === 429) {
            console.log("❌ Rate limit (429):", response.data);
            throw new Error("Rate limit exceeded. Free tier has strict limits. Wait before trying again.");
            
        } else {
            console.log(`⚠️ Unexpected status ${response.status}:`, response.data);
            throw new Error(`API returned status ${response.status}: ${response.data?.message || 'Unknown error'}`);
        }

    } catch (error) {
        console.error("\n❌ V2 API Error Details:");
        console.error("Error message:", error.message);
        
        if (error.response) {
            console.error("Status code:", error.response.status);
            console.error("Response data:", error.response.data);
            console.error("Response headers:", error.response.headers);
            
            // Special handling for common errors
            if (error.response.status === 404) {
                console.log("\n🔍 404 Error Diagnosis:");
                console.log("1. Endpoint: POST https://api.heygen.com/v2/video/generate");
                console.log("2. Your documentation shows '0 Requests That Month'");
                console.log("3. This means your API key hasn't made successful requests");
                console.log("4. Possible causes:");
                console.log("   - API key is invalid");
                console.log("   - V2 API not available on free plan");
                console.log("   - Account needs activation");
                console.log("   - Wrong API version for your plan");
                
                // Try V1 as fallback
                console.log("\n🔄 Attempting V1 API as fallback...");
                try {
                    return await generateHygenVideoV1(script, subtopic, avatar);
                } catch (v1Error) {
                    console.log("❌ V1 API also failed:", v1Error.message);
                    throw new Error(`Both V2 and V1 APIs failed. V2: ${error.message}, V1: ${v1Error.message}`);
                }
            }
        } else if (error.request) {
            console.error("No response received:", error.request);
        } else {
            console.error("Request setup error:", error.message);
        }
        
        throw error;
    }
}

// ✅ V1 API Fallback Function
async function generateHygenVideoV1(script, subtopic, avatar = "anna") {
    console.log("\n🔄 Trying V1 API as fallback...");
    
    let cleanScript = script.replace(/<[^>]*>/g, '');
    if (cleanScript.length > 300) {
        cleanScript = cleanScript.substring(0, 300) + "...";
    }
    
    const requestData = {
        video_inputs: [{
            character: {
                type: "avatar",
                avatar_id: avatar,
                avatar_style: "normal"
            },
            voice: {
                type: "text",
                input_text: cleanScript,
                voice_id: "1bd001e7e50f421d891986aad5158bc8"
            },
            background: {
                type: "color",
                value: "#FFFFFF"
            }
        }],
        aspect_ratio: "16:9",
        caption: false,
        test: true
    };
    
    try {
        const response = await axios.post(
            'https://api.heygen.com/v1/video/generate',
            requestData,
            {
                headers: {
                    'X-Api-Key': HYGEN_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 120000
            }
        );
        
        console.log("✅ V1 API response received");
        console.log("Response:", JSON.stringify(response.data, null, 2));
        
        if (response.data.data?.video_id) {
            return response.data.data.video_id;
        } else if (response.data.video_id) {
            return response.data.video_id;
        } else {
            throw new Error("No video_id in V1 response");
        }
        
    } catch (error) {
        console.error("❌ V1 API failed:");
        console.error("Status:", error.response?.status);
        console.error("Error:", error.response?.data || error.message);
        throw error;
    }
}

// ✅ V2 API Polling Function
async function pollHygenVideoStatus(videoId, jobId) {
    const MAX_POLLS = 180; // Free tier is slower - 30 minutes max
    let pollCount = 0;
    
    console.log(`⏳ [V2 API] Polling video status: ${videoId}`);
    
    while (pollCount < MAX_POLLS) {
        await new Promise(r => setTimeout(r, 10000)); // Poll every 10 seconds
        pollCount++;
        
        if (jobStatus.has(jobId)) {
            jobStatus.set(jobId, {
                ...jobStatus.get(jobId),
                progress: `Polling V2 API (${pollCount}/${MAX_POLLS})`,
                polls: pollCount,
                estimatedTime: `${Math.round((MAX_POLLS - pollCount) * 10 / 60)} minutes remaining`
            });
        }
        
        try {
            // Try V2 endpoint first
            console.log(`📊 Poll ${pollCount}/${MAX_POLLS}: Checking V2 status...`);
            const response = await axios.get(
                `https://api.heygen.com/v2/video/${videoId}`,
                {
                    headers: { 
                        'X-Api-Key': HYGEN_API_KEY,
                        'Accept': 'application/json'
                    },
                    timeout: 30000
                }
            );
            
            console.log("V2 Status response:", JSON.stringify(response.data, null, 2));
            
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
                    throw new Error("Video generation failed");
                } else if (status === "processing") {
                    console.log("⏳ Still processing...");
                }
            }
            
        } catch (error) {
            console.log(`⚠️ V2 poll failed: ${error.message}`);
            
            // Try V1 as fallback
            if (pollCount % 5 === 0) {
                try {
                    console.log(`🔄 Trying V1 status endpoint...`);
                    const v1Response = await axios.get(
                        `https://api.heygen.com/v1/video_status/get?video_id=${videoId}`,
                        {
                            headers: { 'X-Api-Key': HYGEN_API_KEY },
                            timeout: 30000
                        }
                    );
                    
                    console.log("V1 Status response:", JSON.stringify(v1Response.data, null, 2));
                    
                    if (v1Response.data.data?.status === "completed") {
                        return v1Response.data.data.video_url;
                    }
                } catch (v1Error) {
                    console.log(`⚠️ V1 poll also failed: ${v1Error.message}`);
                }
            }
        }
    }
    
    throw new Error(`Polling timeout after ${MAX_POLLS} attempts (30 minutes)`);
}

// ✅ FIXED: Background Job Processing
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

        // Step 1: Generate video with HeyGen
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Calling HeyGen V2 API...'
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

// ✅ NEW: Test V2 API Connection
app.get("/api/test-v2-connection", async (req, res) => {
    try {
        console.log("\n🔧 Testing HeyGen V2 API Connection...");
        
        if (!HYGEN_API_KEY) {
            return res.json({
                success: false,
                error: "No API key configured in .env",
                solution: "Add HYGEN_API_KEY=your_key to .env file"
            });
        }
        
        // Test 1: Simple ping to check connectivity
        console.log("1. Testing V2 ping endpoint...");
        let pingResult = { success: false };
        try {
            const pingResponse = await axios.get('https://api.heygen.com/v2/ping', {
                headers: { 'X-Api-Key': HYGEN_API_KEY },
                timeout: 10000
            });
            pingResult = {
                success: true,
                status: pingResponse.status,
                data: pingResponse.data
            };
            console.log("✅ V2 ping successful");
        } catch (pingError) {
            pingResult = {
                success: false,
                status: pingError.response?.status,
                error: pingError.message,
                details: pingError.response?.data
            };
            console.log("❌ V2 ping failed:", pingError.message);
        }
        
        // Test 2: Test with minimal video generation
        console.log("\n2. Testing V2 video generation...");
        let videoResult = { success: false };
        
        // Use minimal parameters
        const testData = {
            video_inputs: [{
                character: {
                    type: "avatar",
                    avatar_id: "anna",
                    avatar_style: "normal"
                },
                voice: {
                    type: "text",
                    input_text: "This is a test video to check API connectivity.",
                    voice_id: "1bd001e7e50f421d891986aad5158bc8"
                }
            }],
            aspect_ratio: "16:9",
            test: true  // Important for testing
        };
        
        try {
            const videoResponse = await axios.post(
                'https://api.heygen.com/v2/video/generate',
                testData,
                {
                    headers: {
                        'X-Api-Key': HYGEN_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
            
            videoResult = {
                success: true,
                status: videoResponse.status,
                hasVideoId: !!(videoResponse.data?.data?.video_id || videoResponse.data?.video_id),
                response: videoResponse.data
            };
            
            console.log("✅ V2 video generation successful");
            console.log("Response:", JSON.stringify(videoResponse.data, null, 2));
            
        } catch (videoError) {
            videoResult = {
                success: false,
                status: videoError.response?.status,
                error: videoError.message,
                details: videoError.response?.data,
                requestData: testData
            };
            
            console.log("❌ V2 video generation failed:");
            console.log("Status:", videoError.response?.status);
            console.log("Error:", videoError.response?.data || videoError.message);
        }
        
        // Analyze results
        const diagnosis = {
            apiKeyValid: pingResult.success || videoResult.success,
            v2ApiAvailable: pingResult.success,
            canGenerateVideos: videoResult.success,
            planStatus: videoResult.status === 402 ? "Payment required - no credits" : 
                       videoResult.status === 403 ? "Forbidden - no API access" :
                       videoResult.status === 404 ? "Not found - wrong endpoint" :
                       videoResult.status === 401 ? "Unauthorized - invalid key" : "Unknown"
        };
        
        res.json({
            success: pingResult.success || videoResult.success,
            tests: {
                ping: pingResult,
                video_generation: videoResult
            },
            diagnosis: diagnosis,
            yourPlan: "HeyGen Free (10 credits remaining)",
            apiKey: HYGEN_API_KEY.substring(0, 15) + "...",
            recommendations: [
                pingResult.success ? "✅ V2 API is accessible" : "❌ V2 API not accessible",
                videoResult.success ? "✅ Can generate videos" : "❌ Cannot generate videos",
                diagnosis.planStatus === "Payment required - no credits" ? 
                    "💡 Solution: Add credits or upgrade plan" : "",
                diagnosis.planStatus === "Forbidden - no API access" ?
                    "💡 Solution: Free plan may not include API. Upgrade to Creator plan ($29/month)" : "",
                diagnosis.planStatus === "Not found - wrong endpoint" ?
                    "💡 Solution: Try V1 API instead" : "",
                diagnosis.planStatus === "Unauthorized - invalid key" ?
                    "💡 Solution: Get new API key from https://app.heygen.com/settings/api" : ""
            ].filter(r => r),
            nextSteps: [
                "1. Visit: https://app.heygen.com/settings/api",
                "2. Check if API Token section exists",
                "3. If no API section, your plan doesn't include API access",
                "4. Contact support@heygen.com for help",
                "5. Or upgrade to Creator plan at https://app.heygen.com/pricing"
            ]
        });
        
    } catch (error) {
        console.error("❌ Diagnostic failed:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ Quick Test HeyGen API
app.get("/api/quick-test", async (req, res) => {
    try {
        console.log("\n⚡ Quick Testing HeyGen API...");
        
        if (!HYGEN_API_KEY) {
            return res.json({
                success: false,
                error: "API key missing in .env file"
            });
        }
        
        // Simple test with curl-like approach
        const testUrl = "https://api.heygen.com/v1/ping";
        
        try {
            const response = await axios.get(testUrl, {
                headers: { 'X-Api-Key': HYGEN_API_KEY },
                timeout: 5000
            });
            
            res.json({
                success: true,
                message: "✅ HeyGen API is accessible",
                status: response.status,
                data: response.data,
                yourApiKey: HYGEN_API_KEY.substring(0, 20) + "...",
                note: "If you see '0 Requests That Month' in docs, your key hasn't made successful requests"
            });
            
        } catch (error) {
            res.json({
                success: false,
                error: `API test failed: ${error.message}`,
                status: error.response?.status,
                details: error.response?.data,
                solution: "Check: 1. API key validity, 2. Internet connection, 3. Account permissions"
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
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
            "POST /generate-hygen-video",
            "POST /api/save-to-db",
            "GET /api/job-status/:jobId",
            "GET /api/debug-collections",
            "GET /api/debug-find-doc",
            "GET /api/test-v2-connection (NEW - test API)",
            "GET /api/quick-test (NEW - simple test)",
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
            note: "Your docs show '0 Requests That Month' - means no successful API calls yet"
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
        console.log(`   ⚠️ Note: Your docs show '0 Requests That Month' - no successful API calls yet`);
    }
    console.log(`\n✅ Available Endpoints:`);
    console.log(`   POST /generate-hygen-video (Returns immediately, processes in background)`);
    console.log(`   POST /api/save-to-db`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   GET /api/debug-collections`);
    console.log(`   GET /api/debug-find-doc`);
    console.log(`   GET /api/test-v2-connection (Test HeyGen V2 API)`);
    console.log(`   GET /api/quick-test (Simple API test)`);
    console.log(`   GET /health`);
    
    // Test HeyGen API on startup
    if (HYGEN_API_KEY) {
        console.log("\n🔍 Testing HeyGen API connection on startup...");
        setTimeout(async () => {
            try {
                const response = await axios.get('https://api.heygen.com/v1/ping', {
                    headers: { 'X-Api-Key': HYGEN_API_KEY },
                    timeout: 10000
                }).catch(() => null);
                
                if (response?.status === 200) {
                    console.log("✅ HeyGen API v1 endpoint is accessible");
                } else {
                    console.log("⚠️ HeyGen API v1 endpoint may not be available");
                    console.log("   This could mean:");
                    console.log("   1. API key is invalid");
                    console.log("   2. Free plan doesn't include API access");
                    console.log("   3. Account needs activation");
                }
            } catch (error) {
                console.log("⚠️ Could not test HeyGen API on startup");
            }
        }, 2000);
    }
});
