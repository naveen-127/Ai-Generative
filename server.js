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
    req.setTimeout(300000);
    res.setTimeout(300000);
    next();
});

// ✅ AWS S3 Configuration - FIXED PATH
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1', // Mumbai region
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations-test-admin';
// ✅ FIXED: Changed from 'subtopics/ai_videourl/' to 'subtopics/'
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

// ✅ FIXED: Update nested subtopic in units array - WITH BETTER DEBUGGING
async function updateNestedSubtopicInUnits(collection, subtopicId, videoUrl) {
    console.log(`\n🔍 [DB UPDATE] Searching for subtopicId: ${subtopicId} in collection: ${collection.collectionName}`);
    
    try {
        // Try multiple query strategies
        const queryStrategies = [
            { "units._id": subtopicId },
            { "units._id": subtopicId.toString() },
            { "units.id": subtopicId },
            { "_id": subtopicId }, // Also check if it's a main document
        ];

        let parentDoc = null;
        let strategyUsed = "";

        for (const query of queryStrategies) {
            console.log(`   🔍 Trying query: ${JSON.stringify(query)}`);
            parentDoc = await collection.findOne(query);
            if (parentDoc) {
                strategyUsed = JSON.stringify(query);
                console.log(`   ✅ Found with strategy: ${strategyUsed}`);
                break;
            }
        }

        if (!parentDoc) {
            console.log(`   ❌ No document found for subtopicId: ${subtopicId}`);
            return { updated: false, message: "No parent document found" };
        }

        console.log(`   📄 Parent document found:`);
        console.log(`      - _id: ${parentDoc._id}`);
        console.log(`      - unitName: ${parentDoc.unitName || 'N/A'}`);
        console.log(`      - Has units array: ${parentDoc.units && Array.isArray(parentDoc.units)}`);
        
        if (parentDoc.units && Array.isArray(parentDoc.units)) {
            console.log(`      - Units count: ${parentDoc.units.length}`);
            const foundUnit = parentDoc.units.find(u => 
                u._id === subtopicId || 
                u._id === subtopicId.toString() || 
                u.id === subtopicId
            );
            console.log(`      - Found unit in array: ${!!foundUnit}`);
            if (foundUnit) {
                console.log(`      - Unit name: ${foundUnit.unitName}`);
            }
        }

        // Check if this is a main document (not in units array)
        if (parentDoc._id.toString() === subtopicId || parentDoc._id === subtopicId) {
            console.log(`   📝 This appears to be a MAIN document, not nested in units array`);
            // Update main document
            const result = await collection.updateOne(
                { "_id": parentDoc._id },
                {
                    $set: {
                        aiVideoUrl: videoUrl,
                        updatedAt: new Date(),
                        videoStorage: videoUrl.includes('amazonaws.com') ? "aws_s3" : "d_id",
                        s3Path: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.matchedCount > 0) {
                console.log(`   ✅ Updated MAIN document. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
                return { 
                    updated: true, 
                    location: "main_document",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: parentDoc._id,
                    collectionName: collection.collectionName
                };
            }
        }

        // If it's in units array, update using positional operator
        if (parentDoc.units && Array.isArray(parentDoc.units)) {
            console.log(`   🔧 Updating in units array using positional operator...`);
            const result = await collection.updateOne(
                { 
                    "_id": parentDoc._id,
                    "units._id": subtopicId
                },
                {
                    $set: {
                        "units.$.aiVideoUrl": videoUrl,
                        "units.$.updatedAt": new Date(),
                        "units.$.videoStorage": videoUrl.includes('amazonaws.com') ? "aws_s3" : "d_id",
                        "units.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            console.log(`   📊 Update result - Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
            
            if (result.matchedCount > 0) {
                // Verify
                const updatedDoc = await collection.findOne({ "_id": parentDoc._id });
                if (updatedDoc && updatedDoc.units) {
                    const updatedUnit = updatedDoc.units.find(u => 
                        u._id === subtopicId || u._id === subtopicId.toString()
                    );
                    if (updatedUnit && updatedUnit.aiVideoUrl === videoUrl) {
                        console.log(`   ✅ VERIFIED - aiVideoUrl saved: ${updatedUnit.aiVideoUrl}`);
                    }
                }
                
                return { 
                    updated: true, 
                    location: "nested_units_array",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: parentDoc._id,
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

// ✅ AWS S3 Upload Function - WITH PROPER REGION
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("\n☁️ [S3 UPLOAD] Starting S3 upload...");
        console.log(`   📁 Bucket: ${S3_BUCKET_NAME}`);
        console.log(`   📁 Folder: ${S3_FOLDER_PATH}`);
        console.log(`   📄 Filename: ${filename}`);
        console.log(`   📥 Source D-ID URL: ${videoUrl}`);

        // Download video from D-ID
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
        });

        console.log(`   ✅ Video downloaded, size: ${response.data.length} bytes`);

        // Upload to S3 - FIXED: Create folder if it doesn't exist
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

        // Return S3 URL - FIXED REGION
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

// ✅ FIXED: Video generation endpoint
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
        console.log(`   📁 Database: ${dbname}`);
        console.log(`   📚 Subject: ${subjectName || 'All collections'}`);

        const jobId = Date.now().toString();

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'processing',
            subtopic: subtopic,
            startedAt: new Date(),
            questions: questions.length,
            presenter: presenter_id,
            subtopicId: subtopicId
        });

        // Return immediate response
        res.json({
            status: "processing",
            message: "AI video generation started",
            job_id: jobId,
            subtopic: subtopic,
            note: "Video will be uploaded to AWS S3 and saved to database automatically"
        });

        // Process in background
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

    } catch (err) {
        console.error("❌ Error starting video generation:", err);
        res.status(500).json({ error: "Failed to start video generation: " + err.message });
    }
});

// ✅ FIXED: Background video processing with COMPREHENSIVE DATABASE SEARCH
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

                    // ✅ AUTOMATICALLY UPLOAD TO S3
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

                            // ✅ AUTOMATICALLY SAVE S3 URL TO DATABASE
                            if (s3Url && subtopicId) {
                                console.log("\n💾 Saving S3 URL to database...");
                                console.log(`🔗 S3 URL: ${s3Url}`);
                                console.log(`🎯 Subtopic ID: ${subtopicId}`);
                                console.log(`📁 Database: ${dbname}`);

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                // Save to database
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

                                    // Try to update
                                    const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, s3Url);
                                    if (updateResult.updated) {
                                        updated = true;
                                        updateLocation = updateResult.location;
                                        updatedCollection = collectionName;
                                        console.log(`✅ SUCCESS in ${collectionName} at ${updateLocation}`);
                                        break;
                                    } else {
                                        console.log(`   ❌ Not found in ${collectionName}`);
                                    }
                                }

                                if (updated) {
                                    console.log(`\n🎉 S3 URL saved to database in ${updatedCollection} at ${updateLocation}`);
                                    
                                    // Update job status
                                    jobStatus.set(jobId, {
                                        status: 'completed',
                                        subtopic: subtopic,
                                        videoUrl: s3Url, // S3 URL
                                        s3Url: s3Url, // Also store as s3Url for clarity
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
                                    console.log(`   3. Collections searched: ${targetCollections.length}`);
                                    console.log(`   4. S3 URL was: ${s3Url}`);
                                    
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
                                        subtopicIdForManualSave: subtopicId
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

// ✅ Job Status Endpoint - IMPROVED RESPONSE
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

        // If job is completed with S3 URL but not saved to DB, provide info for manual save
        if (status.status === 'completed' && status.s3Url && !status.databaseUpdated) {
            status.manualSaveInfo = {
                s3Url: status.s3Url,
                subtopicId: status.subtopicId || status.subtopicIdForManualSave,
                message: "Video uploaded to S3 but not saved to database. Use /api/upload-to-s3-and-save endpoint."
            };
        }

        res.json(status);
    } catch (error) {
        console.error("❌ Job status check failed:", error);
        res.status(500).json({ error: "Failed to check job status" });
    }
});

// ✅ FIXED: Manual save endpoint with BETTER SEARCH
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

            // Try to update
            const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, videoUrl);
            if (updateResult.updated) {
                updated = true;
                updateLocation = updateResult.location;
                updatedCollection = collectionName;
                console.log(`✅ SUCCESS in ${collectionName}`);
                break;
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
                message: `Video URL saved to database successfully in ${updatedCollection}`
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
                instructions: "Check if subtopic ID exists in database and try manual update in MongoDB"
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
                    { "id": subtopicId }
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
    console.log(`   GET /api/debug-collections`);
    console.log(`   GET /api/debug-find-doc`);
    console.log(`   GET /health`);
});
