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

// ✅ AWS S3 Configuration
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations-test-admin';
const S3_FOLDER_PATH = 'subtopics/ai_videourl/';

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

// ✅ FIXED: Update nested subtopic in units array
async function updateNestedSubtopicInUnits(collection, subtopicId, videoUrl) {
    console.log(`🔍 Looking for subtopicId: ${subtopicId} in units array`);
    
    try {
        // First, try to find the parent document containing this subtopic
        const parentDoc = await collection.findOne({
            "units._id": subtopicId
        });
        
        if (!parentDoc) {
            console.log("❌ Parent document not found for subtopicId:", subtopicId);
            return { updated: false, message: "Parent document not found" };
        }
        
        console.log("✅ Found parent document:", parentDoc._id);
        
        // Update the specific unit in the units array
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
        
        if (result.matchedCount > 0) {
            console.log(`✅ Updated subtopic in units array. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
            
            // Verify the update
            const updatedDoc = await collection.findOne({ "_id": parentDoc._id });
            if (updatedDoc && updatedDoc.units) {
                const updatedSubtopic = updatedDoc.units.find(u => u._id === subtopicId);
                if (updatedSubtopic) {
                    console.log("✅ Verification successful - Subtopic now has aiVideoUrl:", updatedSubtopic.aiVideoUrl);
                }
            }
            
            return { 
                updated: true, 
                location: "nested_units_array",
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount,
                parentId: parentDoc._id
            };
        }
        
        return { updated: false, message: "No matching subtopic found in units array" };
        
    } catch (error) {
        console.error("❌ Error updating nested subtopic:", error);
        return { updated: false, message: error.message };
    }
}

// ✅ FIXED: Update direct subtopic (main document)
async function updateDirectSubtopic(collection, subtopicId, videoUrl) {
    console.log(`🔍 Trying to update as main document with ID: ${subtopicId}`);
    
    try {
        const result = await collection.updateOne(
            { "_id": subtopicId },
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
            console.log(`✅ Updated as main document. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
            return { 
                updated: true, 
                location: "main_document_string",
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount
            };
        }
        
        return { updated: false, message: "Not found as main document" };
        
    } catch (error) {
        console.error("❌ Error updating direct subtopic:", error);
        return { updated: false, message: error.message };
    }
}

// ✅ AWS S3 Upload Function
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("☁️ Uploading D-ID video to AWS S3...");
        console.log("📁 Bucket:", S3_BUCKET_NAME);
        console.log("📁 Folder:", S3_FOLDER_PATH);
        console.log("📄 Filename:", filename);
        console.log("📥 Source D-ID URL:", videoUrl);

        // Download video from D-ID
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
        });

        console.log("✅ Video downloaded for S3, size:", response.data.length, "bytes");

        // Upload to S3
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: `${S3_FOLDER_PATH}${filename}`,
            Body: response.data,
            ContentType: 'video/mp4',
            ACL: 'public-read'
        });

        const result = await s3Client.send(command);
        console.log("✅ Upload to S3 successful");

        // Return S3 URL
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${S3_FOLDER_PATH}${filename}`;
        console.log("🔗 S3 Public URL:", s3Url);

        return s3Url;
    } catch (error) {
        console.error("❌ Upload to S3 failed:", error);
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

        console.log("🎬 GENERATE VIDEO:", { subtopic, subtopicId });

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

// ✅ FIXED: Background video processing
async function processVideoJob(jobId, { subtopic, description, questions, presenter_id, subtopicId, parentId, rootId, dbname, subjectName }) {
    const MAX_POLLS = 60;

    try {
        console.log(`🔄 Processing video job ${jobId} for:`, subtopic);

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
        console.log("⏳ Clip created with ID:", clipId);

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
                console.log(`📊 Poll ${pollCount}/${MAX_POLLS}:`, status);

                // Update job status
                jobStatus.set(jobId, {
                    ...jobStatus.get(jobId),
                    progress: `Processing... (${pollCount}/${MAX_POLLS})`,
                    currentStatus: status
                });

                if (status === "done") {
                    videoUrl = poll.data.result_url;
                    console.log("✅ D-ID Video generated:", videoUrl);

                    // ✅ AUTOMATICALLY UPLOAD TO S3
                    if (videoUrl && videoUrl.includes('d-id.com')) {
                        console.log("☁️ Starting S3 upload...");

                        jobStatus.set(jobId, {
                            ...jobStatus.get(jobId),
                            progress: 'Uploading to AWS S3...'
                        });

                        try {
                            // Generate unique filename
                            const timestamp = Date.now();
                            const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
                            const filename = `video_${safeSubtopicName}_${timestamp}.mp4`;

                            console.log("📄 Uploading to S3 with filename:", filename);

                            // Upload to AWS S3
                            const s3Url = await uploadToS3(videoUrl, filename);
                            console.log("✅ S3 Upload successful:", s3Url);

                            // ✅ AUTOMATICALLY SAVE S3 URL TO DATABASE
                            if (s3Url && subtopicId) {
                                console.log("💾 Saving S3 URL to database...");
                                console.log("🔗 S3 URL:", s3Url);
                                console.log("🎯 Subtopic ID:", subtopicId);

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                // Save to database
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

                                console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);

                                for (const collectionName of targetCollections) {
                                    const collection = dbConn.collection(collectionName);
                                    console.log(`🔍 Processing collection: ${collectionName}`);

                                    // ✅ FIXED: FIRST try to update in units array (for nested subtopics)
                                    const nestedUpdate = await updateNestedSubtopicInUnits(collection, subtopicId, s3Url);
                                    if (nestedUpdate.updated) {
                                        updated = true;
                                        updateLocation = nestedUpdate.location;
                                        updatedCollection = collectionName;
                                        console.log(`✅ Updated in units array: ${updateLocation}`);
                                        break;
                                    }

                                    // ✅ SECOND: Try as main document
                                    const directUpdate = await updateDirectSubtopic(collection, subtopicId, s3Url);
                                    if (directUpdate.updated) {
                                        updated = true;
                                        updateLocation = directUpdate.location;
                                        updatedCollection = collectionName;
                                        console.log(`✅ Updated as main document: ${updateLocation}`);
                                        break;
                                    }
                                }

                                if (updated) {
                                    console.log(`✅ S3 URL saved to database in ${updatedCollection} at ${updateLocation}`);

                                    // Update job status
                                    jobStatus.set(jobId, {
                                        status: 'completed',
                                        subtopic: subtopic,
                                        videoUrl: s3Url, // S3 URL
                                        completedAt: new Date(),
                                        questions: questions.length,
                                        presenter: presenter_id,
                                        storedIn: 'aws_s3',
                                        databaseUpdated: true,
                                        updateLocation: updateLocation,
                                        collection: updatedCollection
                                    });

                                    console.log("🎉 PROCESS COMPLETE: Video generated, uploaded to S3, and saved to database!");

                                } else {
                                    console.log("⚠️ S3 URL generated but could not save to database");
                                    console.log("📝 Subtopic ID may not exist or have different structure");
                                    
                                    jobStatus.set(jobId, {
                                        status: 'completed',
                                        subtopic: subtopic,
                                        videoUrl: s3Url,
                                        completedAt: new Date(),
                                        questions: questions.length,
                                        presenter: presenter_id,
                                        storedIn: 'aws_s3',
                                        databaseUpdated: false,
                                        note: 'Subtopic not found in database'
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
                                videoUrl: videoUrl, // D-ID URL as fallback
                                completedAt: new Date(),
                                questions: questions.length,
                                presenter: presenter_id,
                                storedIn: 'd_id',
                                databaseUpdated: false,
                                error: 'S3 upload failed'
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
                            storedIn: 'unknown'
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

// ✅ FIXED: Manual save endpoint
app.post("/api/upload-to-s3-and-save", async (req, res) => {
    console.log("📤 Manual save request");
    
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

        console.log("📝 Manual save details:", { subtopicId, videoUrlLength: videoUrl ? videoUrl.length : 0 });

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
        } else {
            const collections = await dbConn.listCollections().toArray();
            targetCollections = collections.map(c => c.name);
        }

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";

        console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            console.log(`🔍 Processing collection: ${collectionName}`);

            // Try nested update first
            const nestedUpdate = await updateNestedSubtopicInUnits(collection, subtopicId, videoUrl);
            if (nestedUpdate.updated) {
                updated = true;
                updateLocation = nestedUpdate.location;
                updatedCollection = collectionName;
                break;
            }

            // Try direct update
            const directUpdate = await updateDirectSubtopic(collection, subtopicId, videoUrl);
            if (directUpdate.updated) {
                updated = true;
                updateLocation = directUpdate.location;
                updatedCollection = collectionName;
                break;
            }
        }

        console.log(`📊 Manual save result: ${updated ? 'SUCCESS' : 'FAILED'}`);

        res.json({
            success: true,
            s3_url: videoUrl,
            stored_in: "database",
            database_updated: updated,
            location: updateLocation,
            collection: updatedCollection,
            message: updated ? 
                "Video URL saved to database successfully" : 
                "Video URL not saved - subtopic not found"
        });

    } catch (error) {
        console.error("❌ Manual save failed:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ Debug endpoint for subtopic
app.get("/api/debug-subtopic/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { dbname = "professional", subjectName } = req.query;

        console.log("🔍 Debugging subtopic:", id);

        const dbConn = getDB(dbname);
        let collections;
        
        if (subjectName) {
            collections = [subjectName];
        } else {
            const dbCollections = await dbConn.listCollections().toArray();
            collections = dbCollections.map(c => c.name);
        }

        let found = false;
        let location = "not_found";
        let collectionFound = "";
        let parentDoc = null;

        for (const collectionName of collections) {
            const collection = dbConn.collection(collectionName);

            // Check in units array
            const parent = await collection.findOne({ "units._id": id });
            if (parent) {
                found = true;
                location = "nested_units_array";
                collectionFound = collectionName;
                parentDoc = parent;
                break;
            }

            // Check as main document
            const mainDoc = await collection.findOne({ "_id": id });
            if (mainDoc) {
                found = true;
                location = "main_document";
                collectionFound = collectionName;
                parentDoc = mainDoc;
                break;
            }
        }

        res.json({
            found: found,
            location: location,
            collection: collectionFound,
            subtopicId: id,
            parentDoc: parentDoc ? { _id: parentDoc._id } : null
        });

    } catch (err) {
        console.error("❌ Debug error:", err);
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
            "GET /api/debug-subtopic/:id",
            "GET /health"
        ]
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
    console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
    console.log(`☁️ AWS S3: ${S3_BUCKET_NAME}/${S3_FOLDER_PATH}`);
    console.log(`✅ Endpoints:`);
    console.log(`   POST /generate-and-upload`);
    console.log(`   POST /api/upload-to-s3-and-save`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   GET /health`);
});
