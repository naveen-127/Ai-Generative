const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ⭐⭐⭐ CRITICAL: Set proper timeouts for CloudFront ⭐⭐⭐
app.use((req, res, next) => {
    req.setTimeout(30000); // 30 seconds to match CloudFront
    res.setTimeout(30000);
    next();
});

// ⭐⭐⭐ CRITICAL: Add response timeout middleware ⭐⭐⭐
app.use((req, res, next) => {
    // Set a timeout for all responses
    const TIMEOUT = 29000; // 29 seconds (just under CloudFront's 30s)
    
    req.setTimeout(TIMEOUT);
    res.setTimeout(TIMEOUT, () => {
        if (!res.headersSent) {
            console.log(`⚠️ Response timeout for ${req.method} ${req.url}`);
            res.status(504).json({
                error: "Gateway Timeout",
                message: "Request took too long. Please try again.",
                suggestion: "Video generation started in background. Check job status later."
            });
        }
    });
    next();
});

// ✅ AWS S3 Configuration - FIXED PATH
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations-test-admin';
const S3_FOLDER_PATH = 'subtopics/';

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

// ✅ D-ID API key
if (!process.env.DID_API_KEY) {
    console.error("❌ Missing DID_API_KEY in .env");
    process.exit(1);
}
const DID_API_KEY = `Basic ${Buffer.from(process.env.DID_API_KEY).toString("base64")}`;

// ✅ FIXED: Comprehensive database search function
async function findAndUpdateSubtopic(collection, subtopicId, videoUrl) {
    console.log(`\n🔍 [DB SEARCH] Searching for subtopicId: ${subtopicId} in collection: ${collection.collectionName}`);
    
    try {
        // Convert to ObjectId if valid
        let objectId;
        try {
            objectId = new ObjectId(subtopicId);
        } catch (e) {
            objectId = subtopicId; // Keep as string if not valid ObjectId
        }

        // Strategy 1: Search as main document
        console.log(`   🔍 Strategy 1: Searching as main document (_id: ${subtopicId})`);
        const mainDoc = await collection.findOne({ _id: objectId });
        if (mainDoc) {
            console.log(`   ✅ Found as main document`);
            const result = await collection.updateOne(
                { _id: objectId },
                {
                    $set: {
                        aiVideoUrl: videoUrl,
                        updatedAt: new Date(),
                        videoStorage: "aws_s3",
                        s3Path: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.modifiedCount > 0) {
                console.log(`   ✅ Updated main document. Modified: ${result.modifiedCount}`);
                return { 
                    updated: true, 
                    location: "main_document",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: objectId,
                    collectionName: collection.collectionName
                };
            }
        }

        // Strategy 2: Search in units array (nested structure)
        console.log(`   🔍 Strategy 2: Searching in units array`);
        const unitsDoc = await collection.findOne({ "units._id": subtopicId });
        if (!unitsDoc) {
            // Try with string comparison
            const unitsDocStr = await collection.findOne({ "units._id": subtopicId.toString() });
            if (unitsDocStr) {
                console.log(`   ✅ Found in units array (string match)`);
                const result = await collection.updateOne(
                    { "units._id": subtopicId.toString() },
                    {
                        $set: {
                            "units.$.aiVideoUrl": videoUrl,
                            "units.$.updatedAt": new Date(),
                            "units.$.videoStorage": "aws_s3",
                            "units.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                        }
                    }
                );
                
                if (result.modifiedCount > 0) {
                    console.log(`   ✅ Updated in units array. Modified: ${result.modifiedCount}`);
                    return { 
                        updated: true, 
                        location: "nested_units_array",
                        matchedCount: result.matchedCount,
                        modifiedCount: result.modifiedCount,
                        parentId: unitsDocStr._id,
                        collectionName: collection.collectionName
                    };
                }
            }
        } else {
            console.log(`   ✅ Found in units array`);
            const result = await collection.updateOne(
                { "units._id": subtopicId },
                {
                    $set: {
                        "units.$.aiVideoUrl": videoUrl,
                        "units.$.updatedAt": new Date(),
                        "units.$.videoStorage": "aws_s3",
                        "units.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.modifiedCount > 0) {
                console.log(`   ✅ Updated in units array. Modified: ${result.modifiedCount}`);
                return { 
                    updated: true, 
                    location: "nested_units_array",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: unitsDoc._id,
                    collectionName: collection.collectionName
                };
            }
        }

        // Strategy 3: Search in children array
        console.log(`   🔍 Strategy 3: Searching in children array`);
        const childrenDoc = await collection.findOne({ "children._id": subtopicId });
        if (childrenDoc) {
            console.log(`   ✅ Found in children array`);
            const result = await collection.updateOne(
                { "children._id": subtopicId },
                {
                    $set: {
                        "children.$.aiVideoUrl": videoUrl,
                        "children.$.updatedAt": new Date(),
                        "children.$.videoStorage": "aws_s3",
                        "children.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.modifiedCount > 0) {
                console.log(`   ✅ Updated in children array. Modified: ${result.modifiedCount}`);
                return { 
                    updated: true, 
                    location: "children_array",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: childrenDoc._id,
                    collectionName: collection.collectionName
                };
            }
        }

        // Strategy 4: Search in subtopics array
        console.log(`   🔍 Strategy 4: Searching in subtopics array`);
        const subtopicsDoc = await collection.findOne({ "subtopics._id": subtopicId });
        if (subtopicsDoc) {
            console.log(`   ✅ Found in subtopics array`);
            const result = await collection.updateOne(
                { "subtopics._id": subtopicId },
                {
                    $set: {
                        "subtopics.$.aiVideoUrl": videoUrl,
                        "subtopics.$.updatedAt": new Date(),
                        "subtopics.$.videoStorage": "aws_s3",
                        "subtopics.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.modifiedCount > 0) {
                console.log(`   ✅ Updated in subtopics array. Modified: ${result.modifiedCount}`);
                return { 
                    updated: true, 
                    location: "subtopics_array",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: subtopicsDoc._id,
                    collectionName: collection.collectionName
                };
            }
        }

        // Strategy 5: Search by id field (not _id)
        console.log(`   🔍 Strategy 5: Searching by id field`);
        const idDoc = await collection.findOne({ "id": subtopicId });
        if (idDoc) {
            console.log(`   ✅ Found by id field`);
            const result = await collection.updateOne(
                { "id": subtopicId },
                {
                    $set: {
                        aiVideoUrl: videoUrl,
                        updatedAt: new Date(),
                        videoStorage: "aws_s3",
                        s3Path: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.modifiedCount > 0) {
                console.log(`   ✅ Updated by id field. Modified: ${result.modifiedCount}`);
                return { 
                    updated: true, 
                    location: "id_field",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: idDoc._id,
                    collectionName: collection.collectionName
                };
            }
        }

        console.log(`   ❌ Subtopic not found in any structure`);
        return { 
            updated: false, 
            message: "Subtopic not found in any database structure",
            strategiesTried: 5
        };

    } catch (error) {
        console.error(`   ❌ Error searching/updating: ${error.message}`);
        return { updated: false, message: error.message };
    }
}

// ✅ AWS S3 Upload Function
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("\n☁️ [S3 UPLOAD] Starting S3 upload...");
        console.log(`   📁 Bucket: ${S3_BUCKET_NAME}`);
        console.log(`   📁 Folder: ${S3_FOLDER_PATH}`);
        console.log(`   📄 Filename: ${filename}`);
        console.log(`   📥 Source URL: ${videoUrl}`);

        // Download video
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
        });

        console.log(`   ✅ Video downloaded, size: ${response.data.length} bytes`);

        // Upload to S3
        const key = `${S3_FOLDER_PATH}${filename}`;
        console.log(`   🔑 S3 Key: ${key}`);
        
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: response.data,
            ContentType: 'video/mp4',
            ACL: 'public-read'
        });

        const result = await s3Client.send(command);
        console.log(`   ✅ Upload to S3 successful`);

        // Return S3 URL
        const region = process.env.AWS_REGION || 'ap-south-1';
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
        console.log(`   🔗 S3 Public URL: ${s3Url}`);

        return s3Url;
    } catch (error) {
        console.error(`   ❌ S3 upload failed: ${error.message}`);
        throw error;
    }
}

// ✅ Dynamic voice selection
function getVoiceForPresenter(presenter_id) {
    const voiceMap = {
        "v2_public_anita@Os4oKCBIgZ": "en-IN-NeerjaNeural",
        "v2_public_lucas@vngv2djh6d": "en-US-GuyNeural",
        "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r": "en-GB-RyanNeural"
    };
    return voiceMap[presenter_id] || "en-US-JennyNeural";
}

// ✅ Job status tracking
const jobStatus = new Map();

// ✅ Video generation endpoint
app.post("/generate-and-upload", async (req, res) => {
    try {
        const {
            subtopic,
            description,
            questions = [],
            presenter_id = "v2_public_anita@Os4oKCBIgZ",
            subtopicId,
            parentId,
            rootId,
            dbname = "professional",
            subjectName
        } = req.body;

        console.log("\n🎬 [VIDEO GENERATION] Starting video generation:");
        console.log(`   📝 Subtopic: ${subtopic}`);
        console.log(`   🎯 Subtopic ID: ${subtopicId}`);
        console.log(`   📚 Subject: ${subjectName}`);

        const jobId = Date.now().toString();

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'processing',
            subtopic: subtopic,
            startedAt: new Date(),
            questions: questions.length,
            presenter: presenter_id,
            subtopicId: subtopicId,
            subjectName: subjectName
        });

        // Return response immediately
        res.json({
            status: "processing",
            message: "AI video generation started",
            job_id: jobId,
            subtopic: subtopic,
            note: "Use /api/job-status/" + jobId + " to check progress"
        });

        // Process in background
        setTimeout(() => {
            processVideoJob(jobId, {
                subtopic,
                description,
                questions,
                presenter_id,
                subtopicId,
                parentId,
                rootId,
                dbname,
                subjectName
            });
        }, 100);

    } catch (err) {
        console.error("❌ Error starting video generation:", err);
        res.status(500).json({ error: "Failed to start video generation: " + err.message });
    }
});

// ✅ Background video processing
async function processVideoJob(jobId, { subtopic, description, questions, presenter_id, subtopicId, parentId, rootId, dbname, subjectName }) {
    const MAX_POLLS = 60;

    try {
        console.log(`\n🔄 [JOB ${jobId}] Processing video for: ${subtopic}`);

        const selectedVoice = getVoiceForPresenter(presenter_id);

        let cleanScript = description;
        cleanScript = cleanScript.replace(/<[^>]*>/g, '');

        if (questions.length > 0) {
            cleanScript += "\n\nNow, let me ask you some questions to test your understanding. ";
            cleanScript += "After each question, I'll pause so you can say your answer out loud, and then I'll tell you if you're correct.\n\n";

            questions.forEach((q, index) => {
                cleanScript += `Question ${index + 1}: ${q.question} `;
                cleanScript += `... [5 second pause] ... `;
                cleanScript += `The correct answer is: ${q.answer}. `;

                if (index === questions.length - 1) {
                    cleanScript += `Great job answering all the questions! `;
                } else {
                    cleanScript += `Let's try the next question. `;
                }
            });
            cleanScript += "Excellent work! You've completed all the practice questions.";
        }

        const requestPayload = {
            presenter_id: presenter_id,
            script: {
                type: "text",
                provider: {
                    type: "microsoft",
                    voice_id: selectedVoice
                },
                input: cleanScript,
                ssml: false
            },
            background: { color: "#f0f8ff" },
            config: {
                result_format: "mp4",
                width: 1280,
                height: 720
            }
        };

        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Calling D-ID API...'
        });

        console.log("⏳ Calling D-ID API...");
        const clipResponse = await axios.post(
            "https://api.d-id.com/clips",
            requestPayload,
            {
                headers: {
                    Authorization: DID_API_KEY,
                    "Content-Type": "application/json"
                },
                timeout: 120000,
            }
        );

        const clipId = clipResponse.data.id;
        console.log(`⏳ Clip created with ID: ${clipId}`);

        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Video rendering...',
            clipId: clipId
        });

        let status = clipResponse.data.status;
        let videoUrl = "";
        let pollCount = 0;

        // Poll for completion
        while (status !== "done" && status !== "error" && pollCount < MAX_POLLS) {
            await new Promise(r => setTimeout(r, 3000));
            pollCount++;

            try {
                const poll = await axios.get(`https://api.d-id.com/clips/${clipId}`, {
                    headers: { Authorization: DID_API_KEY },
                    timeout: 30000,
                });

                status = poll.data.status;
                console.log(`📊 Poll ${pollCount}/${MAX_POLLS}: ${status}`);

                // Update job status
                jobStatus.set(jobId, {
                    ...jobStatus.get(jobId),
                    progress: `Processing... (${pollCount}/${MAX_POLLS})`,
                    currentStatus: status
                });

                if (status === "done") {
                    videoUrl = poll.data.result_url;
                    console.log(`✅ D-ID Video generated: ${videoUrl}`);

                    // Upload to S3
                    if (videoUrl && videoUrl.includes('d-id.com')) {
                        console.log("\n☁️ Starting S3 upload...");

                        jobStatus.set(jobId, {
                            ...jobStatus.get(jobId),
                            progress: 'Uploading to AWS S3...'
                        });

                        try {
                            // Generate unique filename
                            const timestamp = Date.now();
                            const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
                            const filename = `ai_video_${safeSubtopicName}_${timestamp}.mp4`;

                            console.log(`📄 Uploading to S3 with filename: ${filename}`);

                            // Upload to AWS S3
                            const s3Url = await uploadToS3(videoUrl, filename);
                            console.log(`✅ S3 Upload successful: ${s3Url}`);

                            // Save S3 URL to database
                            if (s3Url && subtopicId) {
                                console.log("\n💾 Saving S3 URL to database...");
                                console.log(`🔗 S3 URL: ${s3Url}`);
                                console.log(`🎯 Subtopic ID: ${subtopicId}`);
                                console.log(`📁 Database: ${dbname}`);
                                console.log(`📚 Subject: ${subjectName}`);

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                // Save to database
                                const dbConn = getDB(dbname);
                                let collectionsToSearch = [];
                                
                                if (subjectName) {
                                    collectionsToSearch = [subjectName];
                                    console.log(`🔍 Searching in specific collection: ${subjectName}`);
                                } else {
                                    const collections = await dbConn.listCollections().toArray();
                                    collectionsToSearch = collections.map(c => c.name);
                                    console.log(`🔍 Searching in ALL collections: ${collectionsToSearch.join(', ')}`);
                                }

                                let updated = false;
                                let updateLocation = "not_found";
                                let updatedCollection = "unknown";

                                for (const collectionName of collectionsToSearch) {
                                    console.log(`\n🔍 Processing collection: ${collectionName}`);
                                    const collection = dbConn.collection(collectionName);

                                    // Try to find and update
                                    const updateResult = await findAndUpdateSubtopic(collection, subtopicId, s3Url);
                                    if (updateResult.updated) {
                                        updated = true;
                                        updateLocation = updateResult.location;
                                        updatedCollection = collectionName;
                                        console.log(`✅ SUCCESS in ${collectionName} at ${updateLocation}`);
                                        break;
                                    } else {
                                        console.log(`   ❌ Not found in ${collectionName}: ${updateResult.message}`);
                                    }
                                }

                                if (updated) {
                                    console.log(`\n🎉 S3 URL saved to database in ${updatedCollection} at ${updateLocation}`);
                                    
                                    // Update job status
                                    jobStatus.set(jobId, {
                                        status: 'completed',
                                        subtopic: subtopic,
                                        videoUrl: s3Url,
                                        s3Url: s3Url,
                                        completedAt: new Date(),
                                        questions: questions.length,
                                        presenter: presenter_id,
                                        storedIn: 'aws_s3',
                                        databaseUpdated: true,
                                        updateLocation: updateLocation,
                                        collection: updatedCollection,
                                        message: 'Video generated, uploaded to S3, and saved to database successfully'
                                    });

                                    console.log("✅ PROCESS COMPLETE: Video saved to S3 and database!");

                                } else {
                                    console.log("\n⚠️ COULD NOT SAVE TO DATABASE!");
                                    console.log("📝 Please check:");
                                    console.log(`   1. Subtopic ID exists: ${subtopicId}`);
                                    console.log(`   2. Database: ${dbname}`);
                                    console.log(`   3. Subject: ${subjectName}`);
                                    console.log(`   4. Collections searched: ${collectionsToSearch.length}`);
                                    console.log(`   5. S3 URL was: ${s3Url}`);
                                    
                                    // Store the S3 URL in job status for manual retrieval
                                    jobStatus.set(jobId, {
                                        status: 'completed',
                                        subtopic: subtopic,
                                        videoUrl: s3Url,
                                        s3Url: s3Url,
                                        completedAt: new Date(),
                                        questions: questions.length,
                                        presenter: presenter_id,
                                        storedIn: 'aws_s3',
                                        databaseUpdated: false,
                                        note: 'Subtopic not found in database',
                                        s3UrlForManualSave: s3Url,
                                        subtopicIdForManualSave: subtopicId,
                                        subjectName: subjectName,
                                        dbname: dbname
                                    });
                                }
                            }
                        } catch (uploadError) {
                            console.error("❌ S3 upload failed:", uploadError);
                            
                            // Fall back to D-ID URL
                            console.log("🔄 Falling back to D-ID URL");
                            
                            jobStatus.set(jobId, {
                                status: 'completed',
                                subtopic: subtopic,
                                videoUrl: videoUrl,
                                completedAt: new Date(),
                                questions: questions.length,
                                presenter: presenter_id,
                                storedIn: 'd_id',
                                databaseUpdated: false,
                                error: 'S3 upload failed, using D-ID URL',
                                dIdUrl: videoUrl
                            });
                        }

                    } else {
                        // If not D-ID URL
                        jobStatus.set(jobId, {
                            status: 'completed',
                            subtopic: subtopic,
                            videoUrl: videoUrl,
                            completedAt: new Date(),
                            questions: questions.length,
                            presenter: presenter_id,
                            storedIn: 'unknown',
                            databaseUpdated: false
                        });
                    }

                    break;

                } else if (status === "error") {
                    throw new Error("Clip generation failed: " + (poll.data.error?.message || "Unknown error"));
                }
            } catch (pollError) {
                console.warn(`⚠️ Poll ${pollCount} failed:`, pollError.message);
            }
        }

        if (status !== "done") {
            throw new Error(`Video generation timeout after ${pollCount} polls`);
        }

    } catch (error) {
        console.error("❌ Video generation failed:", error);
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'failed',
            error: error.message,
            failedAt: new Date()
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
                error: "Job not found",
                jobId: jobId
            });
        }

        res.json(status);
    } catch (error) {
        console.error("❌ Job status check failed:", error);
        res.status(500).json({ error: "Failed to check job status" });
    }
});

// ✅ FIXED: Enhanced manual save endpoint with BETTER SEARCH
app.post("/api/upload-to-s3-and-save", async (req, res) => {
    console.log("\n📤 [MANUAL SAVE] Manual save request");
    
    try {
        const {
            videoUrl,
            subtopic,
            subtopicId,
            parentId,
            rootId,
            dbname = "professional",
            subjectName
        } = req.body;

        console.log("📝 Manual save details:", { 
            subtopicId, 
            subtopic,
            subjectName,
            dbname,
            videoUrl: videoUrl ? `${videoUrl.substring(0, 50)}...` : 'None'
        });

        if (!videoUrl || !subtopicId) {
            return res.status(400).json({
                success: false,
                error: "Missing videoUrl or subtopicId"
            });
        }

        // Save to database
        const dbConn = getDB(dbname);
        let collectionsToSearch = [];
        
        if (subjectName) {
            collectionsToSearch = [subjectName];
            console.log(`🔍 Searching in specific collection: ${subjectName}`);
        } else {
            const collections = await dbConn.listCollections().toArray();
            collectionsToSearch = collections.map(c => c.name);
            console.log(`🔍 Searching in ALL collections: ${collectionsToSearch.join(', ')}`);
        }

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";
        let errorMessages = [];

        for (const collectionName of collectionsToSearch) {
            console.log(`\n🔍 Processing collection: ${collectionName}`);
            const collection = dbConn.collection(collectionName);

            // Try to find and update
            const updateResult = await findAndUpdateSubtopic(collection, subtopicId, videoUrl);
            if (updateResult.updated) {
                updated = true;
                updateLocation = updateResult.location;
                updatedCollection = collectionName;
                console.log(`✅ SUCCESS in ${collectionName} at ${updateLocation}`);
                break;
            } else {
                errorMessages.push(`${collectionName}: ${updateResult.message}`);
                console.log(`   ❌ Not found in ${collectionName}: ${updateResult.message}`);
            }
        }

        console.log(`\n📊 Manual save result: ${updated ? 'SUCCESS' : 'FAILED'}`);

        if (updated) {
            res.json({
                success: true,
                s3_url: videoUrl,
                stored_in: "database",
                database_updated: true,
                location: updateLocation,
                collection: updatedCollection,
                message: `Video URL saved to database successfully in ${updatedCollection} at ${updateLocation}`
            });
        } else {
            res.json({
                success: false,
                s3_url: videoUrl,
                stored_in: "s3_only",
                database_updated: false,
                location: updateLocation,
                collection: "none",
                message: "Video URL NOT saved to database - subtopic not found",
                errors: errorMessages,
                instructions: `Check if subtopic ID '${subtopicId}' exists in database '${dbname}' collection '${subjectName || 'any'}' and try manual update in MongoDB`,
                debug_info: {
                    subtopicId: subtopicId,
                    subjectName: subjectName,
                    dbname: dbname,
                    collections_searched: collectionsToSearch,
                    total_collections: collectionsToSearch.length
                }
            });
        }

    } catch (error) {
        console.error("❌ Manual save failed:", error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// ✅ NEW: Debug subtopic endpoint (was missing!)
app.get("/api/debug-subtopic/:subtopicId", async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const { dbname = "professional", subjectName } = req.query;

        console.log(`\n🔍 [DEBUG] Checking subtopic: ${subtopicId}`);
        console.log(`   Database: ${dbname}`);
        console.log(`   Subject: ${subjectName || 'All collections'}`);

        const dbConn = getDB(dbname);
        let collectionsToSearch = [];
        
        if (subjectName) {
            collectionsToSearch = [subjectName];
        } else {
            const collections = await dbConn.listCollections().toArray();
            collectionsToSearch = collections.map(c => c.name);
        }

        let found = false;
        let foundIn = [];
        let details = {};

        for (const collectionName of collectionsToSearch) {
            console.log(`   🔍 Searching in collection: ${collectionName}`);
            const collection = dbConn.collection(collectionName);

            // Try multiple search strategies
            const searchQueries = [
                { _id: subtopicId },
                { "units._id": subtopicId },
                { "children._id": subtopicId },
                { "subtopics._id": subtopicId },
                { "id": subtopicId },
                { _id: new ObjectId(subtopicId) },
                { "units._id": subtopicId.toString() }
            ];

            for (const query of searchQueries) {
                try {
                    const doc = await collection.findOne(query);
                    if (doc) {
                        found = true;
                        foundIn.push({
                            collection: collectionName,
                            query: Object.keys(query)[0],
                            documentId: doc._id,
                            hasUnits: doc.units ? true : false,
                            unitsCount: doc.units ? doc.units.length : 0,
                            hasChildren: doc.children ? true : false,
                            hasSubtopics: doc.subtopics ? true : false
                        });
                        
                        // Store first found document details
                        if (!details.document) {
                            details.document = {
                                _id: doc._id,
                                name: doc.unitName || doc.name || doc.title || 'N/A',
                                hasAiVideoUrl: !!doc.aiVideoUrl
                            };
                        }
                        break;
                    }
                } catch (err) {
                    // Skip invalid queries
                    continue;
                }
            }
        }

        const response = {
            found: found,
            subtopicId: subtopicId,
            dbname: dbname,
            subjectName: subjectName || 'all',
            foundIn: foundIn,
            totalCollectionsSearched: collectionsToSearch.length,
            details: details,
            message: found ? 
                `Subtopic found in ${foundIn.length} location(s)` : 
                `Subtopic not found in database`
        };

        console.log(`   📊 Result: ${found ? 'FOUND' : 'NOT FOUND'}`);
        if (found) {
            console.log(`   📍 Found in: ${foundIn.map(f => `${f.collection} (${f.query})`).join(', ')}`);
        }

        res.json(response);

    } catch (error) {
        console.error("❌ Debug error:", error);
        res.status(500).json({
            found: false,
            error: error.message,
            message: "Error checking subtopic"
        });
    }
});

// ✅ DEBUG: List all collections
app.get("/api/debug-collections", async (req, res) => {
    try {
        const { dbname = "professional" } = req.query;
        const dbConn = getDB(dbname);
        const collections = await dbConn.listCollections().toArray();
        
        console.log("📚 Available collections in database:", collections.map(c => c.name));
        
        res.json({
            database: dbname,
            collections: collections.map(c => c.name),
            count: collections.length
        });
    } catch (error) {
        console.error("❌ Error listing collections:", error);
        res.status(500).json({ error: error.message });
    }
});

// ✅ DEBUG: Search for document
app.get("/api/debug-find-doc", async (req, res) => {
    try {
        const { 
            subtopicId, 
            dbname = "professional",
            collectionName 
        } = req.query;

        console.log(`🔍 Debug find document: ${subtopicId}`);

        const dbConn = getDB(dbname);
        
        if (collectionName) {
            // Search in specific collection
            const collection = dbConn.collection(collectionName);
            const doc = await collection.findOne({
                $or: [
                    { "_id": subtopicId },
                    { "units._id": subtopicId },
                    { "id": subtopicId },
                    { "_id": new ObjectId(subtopicId) }
                ]
            });
            
            res.json({
                found: !!doc,
                collection: collectionName,
                document: doc
            });
        } else {
            // Search in all collections
            const collections = await dbConn.listCollections().toArray();
            let foundDoc = null;
            let foundCollection = "";
            
            for (const coll of collections) {
                const collection = dbConn.collection(coll.name);
                const doc = await collection.findOne({
                    $or: [
                        { "_id": subtopicId },
                        { "units._id": subtopicId },
                        { "id": subtopicId }
                    ]
                });
                
                if (doc) {
                    foundDoc = doc;
                    foundCollection = coll.name;
                    break;
                }
            }
            
            res.json({
                found: !!foundDoc,
                collection: foundCollection,
                document: foundDoc
            });
        }

    } catch (err) {
        console.error("❌ Debug find error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ✅ Health check
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "AI Video Generator with S3 Storage",
        endpoints: [
            "POST /generate-and-upload",
            "POST /api/upload-to-s3-and-save",
            "GET /api/job-status/:jobId",
            "GET /api/debug-subtopic/:subtopicId",
            "GET /api/debug-collections",
            "GET /api/debug-find-doc",
            "GET /health"
        ],
        s3: {
            bucket: S3_BUCKET_NAME,
            folder: S3_FOLDER_PATH,
            region: process.env.AWS_REGION || 'ap-south-1'
        }
    });
});

// ✅ Create assets directory
function ensureAssetsDirectory() {
    const assetsDir = path.join(__dirname, 'assets', 'ai_video');
    if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
        console.log("📁 Created assets directory:", assetsDir);
    }
}

// ✅ Start server
ensureAssetsDirectory();
app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ Server running on http://0.0.0.0:${PORT}`);
    console.log(`☁️ AWS S3 Configuration:`);
    console.log(`   Bucket: ${S3_BUCKET_NAME}`);
    console.log(`   Folder: ${S3_FOLDER_PATH}`);
    console.log(`   Region: ${process.env.AWS_REGION || 'ap-south-1'}`);
    console.log(`\n✅ Available Endpoints:`);
    console.log(`   POST /generate-and-upload`);
    console.log(`   POST /api/upload-to-s3-and-save`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   GET /api/debug-subtopic/:subtopicId`);
    console.log(`   GET /api/debug-collections`);
    console.log(`   GET /api/debug-find-doc`);
    console.log(`   GET /health`);
});
