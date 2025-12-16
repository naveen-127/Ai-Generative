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

// ✅ ADD THIS: Increase server timeouts to prevent 504 errors
app.use((req, res, next) => {
    // Skip timeout for health checks
    if (req.path === '/health' || req.path === '/api/test') {
        next();
        return;
    }
    
    // Set longer timeouts for specific endpoints
    if (req.path === '/generate-and-upload' || req.path.startsWith('/api/job-status/')) {
        req.setTimeout(30000); // 30 seconds for these endpoints
        res.setTimeout(30000);
    } else {
        // Default timeouts for other endpoints
        req.setTimeout(30000); // 30 seconds
        res.setTimeout(30000);
    }
    
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

// ✅ Enhanced CORS middleware
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            console.log("✅ CORS Allowed:", origin);
            return callback(null, true);
        } else {
            console.log("❌ CORS Blocked:", origin);
            return callback(new Error(`CORS policy violation: ${origin} not allowed`), false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));

// ✅ Serve static files from assets directory
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type', 'Authorization', 'X-Requested-With', 'Accept, Origin');
        res.header('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

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

// ✅ FIXED: Job status tracking at the top
const jobStatus = new Map();

// ✅ UPDATED: Improved recursive helper function based on Spring Boot structure
function updateNestedSubtopicRecursive(subtopics, targetId, aiVideoUrl) {
    for (let i = 0; i < subtopics.length; i++) {
        const subtopic = subtopics[i];

        // Check if this is the target subtopic
        if (subtopic._id === targetId || subtopic.id === targetId ||
            (subtopic._id && subtopic._id.toString() === targetId)) {

            subtopic.aiVideoUrl = aiVideoUrl;
            subtopic.updatedAt = new Date();
            subtopic.videoStorage = aiVideoUrl.includes('amazonaws.com') ? "aws_s3" : "d_id";

            if (aiVideoUrl.includes('amazonaws.com')) {
                subtopic.s3Path = aiVideoUrl.split('.com/')[1];
            }

            console.log(`✅ Updated nested subtopic: ${targetId} with URL: ${aiVideoUrl}`);
            return true;
        }

        // Recursively search in child arrays - matching Spring Boot structure
        if (subtopic.units && Array.isArray(subtopic.units)) {
            const found = updateNestedSubtopicRecursive(subtopic.units, targetId, aiVideoUrl);
            if (found) return true;
        }
        
        if (subtopic.children && Array.isArray(subtopic.children)) {
            const found = updateNestedSubtopicRecursive(subtopic.children, targetId, aiVideoUrl);
            if (found) return true;
        }
        
        if (subtopic.subtopics && Array.isArray(subtopic.subtopics)) {
            const found = updateNestedSubtopicRecursive(subtopic.subtopics, targetId, aiVideoUrl);
            if (found) return true;
        }
    }
    return false;
}

// ✅ UPDATED: Helper function for direct subtopic update
async function updateDirectSubtopic(collection, subtopicId, videoUrl) {
    console.log(`🔍 Direct update for subtopicId: ${subtopicId}`);
    
    const strategies = [
        // Strategy 1: Update in units array using _id (String)
        { 
            query: { "units._id": subtopicId }, 
            update: { $set: { "units.$.aiVideoUrl": videoUrl, "units.$.updatedAt": new Date() } },
            location: "nested_units_string_id" 
        },
        // Strategy 2: Update in units array using id field
        { 
            query: { "units.id": subtopicId }, 
            update: { $set: { "units.$.aiVideoUrl": videoUrl, "units.$.updatedAt": new Date() } },
            location: "nested_units_string_id_field" 
        },
        // Strategy 3: Update as main document using _id
        { 
            query: { "_id": subtopicId }, 
            update: { $set: { aiVideoUrl: videoUrl, updatedAt: new Date() } },
            location: "main_document_string" 
        }
    ];

    // Try ObjectId strategies if possible
    try {
        const objectId = new ObjectId(subtopicId);
        strategies.push(
            { 
                query: { "_id": objectId }, 
                update: { $set: { aiVideoUrl: videoUrl, updatedAt: new Date() } },
                location: "main_document_objectid" 
            },
            { 
                query: { "units._id": objectId }, 
                update: { $set: { "units.$.aiVideoUrl": videoUrl, "units.$.updatedAt": new Date() } },
                location: "nested_units_objectid" 
            }
        );
        console.log(`✅ Added ObjectId strategies for: ${subtopicId}`);
    } catch (e) {
        console.log(`⚠️ Cannot convert to ObjectId: ${e.message}`);
    }

    for (const strategy of strategies) {
        try {
            console.log(`🔍 Trying direct update strategy: ${strategy.location}`);
            
            const result = await collection.updateOne(strategy.query, strategy.update);
            console.log(`📊 Result for ${strategy.location}: Matched ${result.matchedCount}, Modified ${result.modifiedCount}`);

            if (result.matchedCount > 0) {
                return {
                    updated: true,
                    location: strategy.location,
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount
                };
            }
        } catch (e) {
            console.log(`⚠️ Direct strategy failed: ${e.message}`);
        }
    }

    return { updated: false };
}

// ✅ Dynamic voice selection based on presenter gender
function getVoiceForPresenter(presenter_id) {
    const voiceMap = {
        "v2_public_anita@Os4oKCBIgZ": "en-IN-NeerjaNeural",
        "v2_public_lucas@vngv2djh6d": "en-US-GuyNeural",
        "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r": "en-GB-RyanNeural"
    };
    return voiceMap[presenter_id] || "en-US-JennyNeural";
}

function generateWebVTTFromScript(scriptText, wordsPerMinute = 150) {
    console.log("📝 Generating WebVTT from script...");
    
    let cleanScript = scriptText;
    
    // Remove D-ID pause markers but keep timing
    const pauseMatches = [];
    cleanScript = cleanScript.replace(/\.\.\. \[(\d+) second pause\] \.\.\./g, (match, seconds) => {
        pauseMatches.push(parseInt(seconds));
        return ' '; // Replace with space
    });
    
    // Split into sentences for better subtitle chunks
    const sentences = cleanScript.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    
    let vttContent = 'WEBVTT\n\n';
    let startTime = 0; // Start at 0 seconds
    const wordsPerSecond = wordsPerMinute / 60;
    
    sentences.forEach((sentence, index) => {
        // Calculate duration based on word count
        const wordCount = sentence.trim().split(/\s+/).length;
        const baseDuration = Math.max(2, Math.ceil(wordCount / wordsPerSecond)); // Minimum 2 seconds
        
        // Add pause time if applicable (simplified logic)
        let additionalPause = 0;
        if (index < pauseMatches.length) {
            additionalPause = pauseMatches[index] || 0;
        }
        
        const duration = baseDuration + additionalPause;
        const endTime = startTime + duration;
        
        // Format times in HH:MM:SS.mmm format
        const startFormatted = formatTimeForVTT(startTime);
        const endFormatted = formatTimeForVTT(endTime);
        
        vttContent += `${index + 1}\n`;
        vttContent += `${startFormatted} --> ${endFormatted}\n`;
        vttContent += `${sentence.trim()}\n\n`;
        
        startTime = endTime;
    });
    
    console.log(`✅ Generated VTT with ${sentences.length} subtitle entries`);
    return vttContent;
}

// Helper function to format seconds to VTT time format
function formatTimeForVTT(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = (seconds % 60).toFixed(3);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`;
}

// ✅ NEW: Upload text content (subtitles) to S3
async function uploadTextToS3(textContent, filename) {
    try {
        console.log("📝 Uploading subtitles to S3...");
        console.log("📄 Subtitle filename:", filename);
        
        const folderPath = S3_FOLDER_PATH.endsWith('/') ? S3_FOLDER_PATH : S3_FOLDER_PATH + '/';
        const key = `${folderPath}${filename}`;
        
        console.log("📤 S3 Key for subtitles:", key);

        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: textContent,
            ContentType: 'text/vtt',
            Metadata: {
                'source': 'ai-video-subtitles',
                'uploaded-at': new Date().toISOString(),
                'format': 'webvtt'
            }
        });

        const result = await s3Client.send(command);
        console.log("✅ Subtitles uploaded to S3, ETag:", result.ETag);

        const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
        console.log("🔗 S3 Subtitle URL:", s3Url);

        return s3Url;
    } catch (error) {
        console.error("❌ Subtitle upload to S3 failed:", error.message);
        throw new Error(`Subtitle S3 upload failed: ${error.message}`);
    }
}
// ✅ AWS S3 Upload Function
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("☁️ Uploading to AWS S3...");
        console.log("📁 Bucket:", S3_BUCKET_NAME);
        console.log("📁 Region:", process.env.AWS_REGION || 'ap-south-1');
        console.log("📁 Folder:", S3_FOLDER_PATH);
        console.log("📄 Filename:", filename);
        
        // Verify AWS credentials
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            throw new Error("AWS credentials not configured in .env file");
        }

        // Download video from D-ID
        console.log("⬇️ Downloading video from D-ID...");
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: {
                'Accept': 'video/mp4',
                'User-Agent': 'Node.js-S3-Uploader'
            }
        });

        console.log("✅ Video downloaded, size:", response.data.length, "bytes");

        if (!response.data || response.data.length === 0) {
            throw new Error("Downloaded video is empty");
        }

        // Ensure folder path ends with /
        const folderPath = S3_FOLDER_PATH.endsWith('/') ? S3_FOLDER_PATH : S3_FOLDER_PATH + '/';
        const key = `${folderPath}${filename}`;
        
        console.log("📤 S3 Key:", key);
        console.log("⬆️ Uploading to S3...");

        // Upload to S3 bucket
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: response.data,
            ContentType: 'video/mp4',
            Metadata: {
                'source': 'd-id-ai-video',
                'uploaded-at': new Date().toISOString(),
                'original-url': videoUrl
            }
        });

        const result = await s3Client.send(command);
        console.log("✅ Upload to S3 successful, ETag:", result.ETag);
        console.log("✅ HTTP Status:", result.$metadata?.httpStatusCode);

        // Generate S3 public URL
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
        console.log("🔗 S3 Public URL:", s3Url);

        return s3Url;
    } catch (error) {
        console.error("❌ Upload to S3 failed with details:");
        console.error("   Error Message:", error.message);
        throw new Error(`S3 upload failed: ${error.message}`);
    }
}


// ✅ IMPROVED: saveVideoToDatabase function with better logging
// ✅ UPDATED: Handle ObjectId format subtopic IDs
// ✅ UPDATED: saveVideoToDatabase function with subtitle support
async function saveVideoToDatabase(s3VideoUrl, s3SubtitleUrl, subtopicId, dbname, subjectName) {
    console.log("💾 SAVE TO DATABASE WITH SUBTITLES: Starting...");
    console.log("📋 Parameters:", {
        subtopicId: subtopicId,
        dbname: dbname,
        subjectName: subjectName,
        videoUrl: s3VideoUrl,
        subtitleUrl: s3SubtitleUrl
    });

    try {
        const dbConn = getDB(dbname);
        
        if (!subjectName || subjectName.trim() === "") {
            throw new Error("subjectName is required");
        }
        
        console.log(`📁 Using collection: ${subjectName}`);
        const collection = dbConn.collection(subjectName);
        
        // First try Spring Boot API
        console.log("🔄 Step 1: Trying Spring Boot API...");
        try {
            const springBootResponse = await axios.put(
                "https://dafj1druksig9.cloudfront.net/api/updateSubtopicVideo",
                {
                    subtopicId: subtopicId,
                    aiVideoUrl: s3VideoUrl,
                    aiSubtitleUrl: s3SubtitleUrl,  // ✅ NEW: Add subtitle URL
                    dbname: dbname,
                    subjectName: subjectName,
                    hasSubtitles: !!s3SubtitleUrl
                },
                {
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                }
            );
            
            console.log("✅ Spring Boot response:", springBootResponse.data);
            
            if (springBootResponse.data && springBootResponse.data.status === "success") {
                return {
                    success: true,
                    message: "Video and subtitles saved to database via Spring Boot",
                    collection: subjectName,
                    updateMethod: "spring_boot",
                    springBootResponse: springBootResponse.data
                };
            }
        } catch (springBootError) {
            console.log("⚠️ Spring Boot failed:", springBootError.message);
        }
        
        // Direct MongoDB update
        console.log("🔄 Step 2: Direct MongoDB update with subtitles...");
        
        // Since subtopicId looks like ObjectId (694042624810ca4a69f4d9bf), try ObjectId first
        let updateResult = null;
        
        if (ObjectId.isValid(subtopicId)) {
            console.log("🔍 SubtopicId appears to be a valid ObjectId");
            const objectId = new ObjectId(subtopicId);
            
            // Try 1: Update in units array with ObjectId
            updateResult = await collection.updateOne(
                { "units._id": objectId },
                { 
                    $set: { 
                        "units.$.aiVideoUrl": s3VideoUrl,
                        "units.$.aiSubtitleUrl": s3SubtitleUrl,  // ✅ NEW
                        "units.$.hasSubtitles": !!s3SubtitleUrl, // ✅ NEW
                        "units.$.updatedAt": new Date(),
                        "units.$.videoStorage": "aws_s3",
                        "units.$.s3Path": s3VideoUrl.split('.com/')[1]
                    } 
                }
            );
            
            console.log("📊 Update with ObjectId in units._id:", {
                matchedCount: updateResult.matchedCount,
                modifiedCount: updateResult.modifiedCount
            });
            
            if (updateResult.modifiedCount > 0) {
                return {
                    success: true,
                    message: "Video and subtitles saved using ObjectId in units array",
                    collection: subjectName,
                    updateMethod: "objectid_units_array",
                    matchedCount: updateResult.matchedCount,
                    modifiedCount: updateResult.modifiedCount
                };
            }
            
            // Try 2: Update as main document with ObjectId
            updateResult = await collection.updateOne(
                { "_id": objectId },
                { 
                    $set: { 
                        "aiVideoUrl": s3VideoUrl,
                        "aiSubtitleUrl": s3SubtitleUrl,        // ✅ NEW
                        "hasSubtitles": !!s3SubtitleUrl,      // ✅ NEW
                        "updatedAt": new Date(),
                        "videoStorage": "aws_s3",
                        "s3Path": s3VideoUrl.split('.com/')[1]
                    } 
                }
            );
            
            console.log("📊 Update as main document with ObjectId:", {
                matchedCount: updateResult.matchedCount,
                modifiedCount: updateResult.modifiedCount
            });
            
            if (updateResult.modifiedCount > 0) {
                return {
                    success: true,
                    message: "Video and subtitles saved as main document with ObjectId",
                    collection: subjectName,
                    updateMethod: "objectid_main_document",
                    matchedCount: updateResult.matchedCount,
                    modifiedCount: updateResult.modifiedCount
                };
            }
        }
        
        // Try with string ID (non-ObjectId)
        console.log("🔍 Step 3: Trying with string ID...");
        
        // Try 3: Update in units array with string _id
        updateResult = await collection.updateOne(
            { "units._id": subtopicId },
            { 
                $set: { 
                    "units.$.aiVideoUrl": s3VideoUrl,
                    "units.$.aiSubtitleUrl": s3SubtitleUrl,  // ✅ NEW
                    "units.$.hasSubtitles": !!s3SubtitleUrl, // ✅ NEW
                    "units.$.updatedAt": new Date(),
                    "units.$.videoStorage": "aws_s3",
                    "units.$.s3Path": s3VideoUrl.split('.com/')[1]
                } 
            }
        );
        
        console.log("📊 Update with string _id in units array:", {
            matchedCount: updateResult.matchedCount,
            modifiedCount: updateResult.modifiedCount
        });
        
        if (updateResult.modifiedCount > 0) {
            return {
                success: true,
                message: "Video and subtitles saved using string _id in units array",
                collection: subjectName,
                updateMethod: "string_units_array",
                matchedCount: updateResult.matchedCount,
                modifiedCount: updateResult.modifiedCount
            };
        }
        
        // Try 4: Update with id field (not _id)
        updateResult = await collection.updateOne(
            { "units.id": subtopicId },
            { 
                $set: { 
                    "units.$.aiVideoUrl": s3VideoUrl,
                    "units.$.aiSubtitleUrl": s3SubtitleUrl,  // ✅ NEW
                    "units.$.hasSubtitles": !!s3SubtitleUrl, // ✅ NEW
                    "units.$.updatedAt": new Date(),
                    "units.$.videoStorage": "aws_s3",
                    "units.$.s3Path": s3VideoUrl.split('.com/')[1]
                } 
            }
        );
        
        console.log("📊 Update with id field in units array:", {
            matchedCount: updateResult.matchedCount,
            modifiedCount: updateResult.modifiedCount
        });
        
        if (updateResult.modifiedCount > 0) {
            return {
                success: true,
                message: "Video and subtitles saved using id field in units array",
                collection: subjectName,
                updateMethod: "id_field_units_array",
                matchedCount: updateResult.matchedCount,
                modifiedCount: updateResult.modifiedCount
            };
        }
        
        // Try 5: Update as main document with string _id
        updateResult = await collection.updateOne(
            { "_id": subtopicId },
            { 
                $set: { 
                    "aiVideoUrl": s3VideoUrl,
                    "aiSubtitleUrl": s3SubtitleUrl,        // ✅ NEW
                    "hasSubtitles": !!s3SubtitleUrl,      // ✅ NEW
                    "updatedAt": new Date(),
                    "videoStorage": "aws_s3",
                    "s3Path": s3VideoUrl.split('.com/')[1]
                } 
            }
        );
        
        console.log("📊 Update as main document with string _id:", {
            matchedCount: updateResult.matchedCount,
            modifiedCount: updateResult.modifiedCount
        });
        
        if (updateResult.modifiedCount > 0) {
            return {
                success: true,
                message: "Video and subtitles saved as main document with string _id",
                collection: subjectName,
                updateMethod: "string_main_document",
                matchedCount: updateResult.matchedCount,
                modifiedCount: updateResult.modifiedCount
            };
        }
        
        // If nothing worked, debug what's in the database
        console.log("🔍 Debug: Checking database contents...");
        const sampleDocs = await collection.find({}).limit(3).toArray();
        
        console.log("📊 Sample documents structure:");
        sampleDocs.forEach((doc, index) => {
            console.log(`Document ${index + 1}:`);
            console.log(`  _id: ${doc._id}`);
            console.log(`  unitName: ${doc.unitName || doc.name || 'N/A'}`);
            console.log(`  hasUnits: ${!!doc.units}`);
            if (doc.units && Array.isArray(doc.units)) {
                console.log(`  units count: ${doc.units.length}`);
                doc.units.slice(0, 3).forEach((unit, unitIndex) => {
                    console.log(`    Unit ${unitIndex + 1}:`);
                    console.log(`      _id: ${unit._id}`);
                    console.log(`      unitName: ${unit.unitName}`);
                    console.log(`      id: ${unit.id || 'N/A'}`);
                    console.log(`      aiVideoUrl: ${unit.aiVideoUrl || 'N/A'}`);
                });
            }
        });
        
        return {
            success: false,
            message: "Subtopic not found in database with any update method",
            collection: subjectName,
            updateMethod: "not_found",
            debug: {
                subtopicId: subtopicId,
                isObjectId: ObjectId.isValid(subtopicId),
                sampleDocuments: sampleDocs.length
            }
        };
        
    } catch (error) {
        console.error("❌ Database save error:", error);
        console.error("❌ Error stack:", error.stack);
        return {
            success: false,
            message: "Database save failed: " + error.message,
            errorDetails: error.toString()
        };
    }
}

// ✅ FIXED: Async video generation with immediate response
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

        console.log("🎬 GENERATE VIDEO: Starting video generation for:", subtopic);

        // Generate unique job ID
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // ✅ VALIDATION: Check for required fields
        if (!subtopic || !description) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields: subtopic and description"
            });
        }

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'processing',
            subtopic: subtopic,
            startedAt: new Date().toISOString(),
            questions: questions.length,
            presenter: presenter_id,
            progress: 'Starting video generation...',
            videoUrl: null,
            error: null,
            subtopicId: subtopicId,
            dbname: dbname,
            subjectName: subjectName
        });

        console.log(`✅ Created job ${jobId} for subtopic: ${subtopic}`);

        // ✅ IMMEDIATE RESPONSE - No timeout!
        res.json({
            success: true,
            status: "processing",
            message: "AI video generation started",
            job_id: jobId,
            subtopic: subtopic,
            note: "Video is being generated. Use /api/job-status/:jobId to check progress.",
            estimated_time: "2-3 minutes",
            check_status: `GET /api/job-status/${jobId}`
        });

        // ✅ PROCESS IN BACKGROUND
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
        }).catch(error => {
            console.error(`❌ Background job ${jobId} failed:`, error);
            jobStatus.set(jobId, {
                ...jobStatus.get(jobId),
                status: 'failed',
                error: error.message,
                failedAt: new Date().toISOString()
            });
        });

    } catch (err) {
        console.error("❌ Error starting video generation:", err);
        res.status(500).json({
            success: false,
            error: "Failed to start video generation: " + err.message
        });
    }
});

// ✅ Background video processing with automatic S3 upload and DB save
// ✅ Background video processing with automatic S3 upload, DB save, and subtitle generation
async function processVideoJob(jobId, { subtopic, description, questions, presenter_id, subtopicId, parentId, rootId, dbname, subjectName }) {
    const MAX_POLLS = 60;

    try {
        console.log(`🔄 Processing video job ${jobId} for:`, subtopic);

        const selectedVoice = getVoiceForPresenter(presenter_id);

        let cleanScript = description;
        cleanScript = cleanScript.replace(/<break time="(\d+)s"\/>/g, (match, time) => {
            return `... [${time} second pause] ...`;
        });
        cleanScript = cleanScript.replace(/<[^>]*>/g, '');

        // Store the original clean script for subtitle generation
        const originalScriptForSubtitles = cleanScript;

        // Add interactive questions to script
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

                // Update job status with progress
                jobStatus.set(jobId, {
                    ...jobStatus.get(jobId),
                    progress: `Processing... (${pollCount}/${MAX_POLLS})`,
                    currentStatus: status
                });

                if (status === "done") {
                    videoUrl = poll.data.result_url;
                    console.log("✅ Video generation completed:", videoUrl);

                    // ✅ AUTOMATICALLY UPLOAD TO S3 WITH SUBTITLES
                    if (videoUrl && videoUrl.includes('d-id.com')) {
                        console.log("☁️ Starting automatic S3 upload...");

                        jobStatus.set(jobId, {
                            ...jobStatus.get(jobId),
                            progress: 'Uploading to AWS S3...'
                        });

                        try {
                            // Generate unique filenames for S3
                            const timestamp = Date.now();
                            const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
                            const videoFilename = `video_${safeSubtopicName}_${timestamp}.mp4`;

                            console.log("📄 Uploading video to S3 with filename:", videoFilename);

                            // 1. Upload video to S3
                            const s3VideoUrl = await uploadToS3(videoUrl, videoFilename);
                            console.log("✅ Video S3 Upload successful:", s3VideoUrl);

                            // 2. ✅ GENERATE SUBTITLES FROM SCRIPT
                            console.log("🎤 Generating subtitles from script...");
                            jobStatus.set(jobId, {
                                ...jobStatus.get(jobId),
                                progress: 'Creating subtitles from script...'
                            });

                            let s3SubtitleUrl = null;
                            try {
                                // Generate WebVTT from the original script
                                const vttContent = generateWebVTTFromScript(originalScriptForSubtitles);
                                
                                // Upload subtitles to S3
                                const subtitleFilename = `subtitle_${safeSubtopicName}_${timestamp}.vtt`;
                                s3SubtitleUrl = await uploadTextToS3(vttContent, subtitleFilename);
                                console.log("✅ Subtitles generated and uploaded to S3:", s3SubtitleUrl);
                            } catch (subtitleError) {
                                console.warn("⚠️ Subtitle generation failed (non-critical):", subtitleError.message);
                                // Continue without subtitles
                            }

                            // ✅ AUTOMATICALLY SAVE S3 URL TO DATABASE
                            if (s3VideoUrl && subtopicId) {
                                console.log("💾 Automatically saving to database...");

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                // Use the UPDATED saveVideoToDatabase function
                                const dbSaveResult = await saveVideoToDatabase(
                                    s3VideoUrl, 
                                    s3SubtitleUrl,  // Pass subtitle URL (can be null)
                                    subtopicId, 
                                    dbname, 
                                    subjectName
                                );
                                
                                console.log("📊 Database save result:", dbSaveResult);

                                // ✅ FINAL: Update job status
                                jobStatus.set(jobId, {
                                    status: 'completed',
                                    subtopic: subtopic,
                                    videoUrl: s3VideoUrl,
                                    subtitleUrl: s3SubtitleUrl,  // ✅ NEW
                                    hasSubtitles: !!s3SubtitleUrl,  // ✅ NEW
                                    scriptLength: originalScriptForSubtitles.length,
                                    completedAt: new Date(),
                                    questions: questions.length,
                                    presenter: presenter_id,
                                    storedIn: 'aws_s3',
                                    databaseUpdated: dbSaveResult.success,
                                    updateMethod: dbSaveResult.updateMethod,
                                    collection: dbSaveResult.collection,
                                    s3Url: s3VideoUrl,
                                    databaseResult: dbSaveResult
                                });

                            } else {
                                console.log("⚠️ No subtopicId provided, cannot save to database");
                                jobStatus.set(jobId, {
                                    status: 'completed',
                                    subtopic: subtopic,
                                    videoUrl: s3VideoUrl,
                                    subtitleUrl: s3SubtitleUrl,  // ✅ NEW
                                    hasSubtitles: !!s3SubtitleUrl,  // ✅ NEW
                                    completedAt: new Date(),
                                    questions: questions.length,
                                    presenter: presenter_id,
                                    storedIn: 'aws_s3',
                                    databaseUpdated: false,
                                    note: 'No subtopicId provided'
                                });
                            }
                        } catch (uploadError) {
                            console.error("❌ S3 upload failed:", uploadError);
                            
                            // If S3 upload fails, use D-ID URL and try to save that
                            if (subtopicId) {
                                console.log("🔄 Trying to save D-ID URL to database as fallback");
                                try {
                                    // Still generate subtitles from script even if S3 fails
                                    let subtitleUrl = null;
                                    try {
                                        const vttContent = generateWebVTTFromScript(originalScriptForSubtitles);
                                        // Save subtitles locally or handle differently
                                        console.log("📝 Subtitles generated (not uploaded to S3)");
                                    } catch (subtitleError) {
                                        console.warn("⚠️ Subtitle generation failed:", subtitleError.message);
                                    }
                                    
                                    const dbSaveResult = await saveVideoToDatabase(videoUrl, subtitleUrl, subtopicId, dbname, subjectName);
                                    console.log("📊 D-ID URL save result:", dbSaveResult);
                                } catch (dbError) {
                                    console.error("❌ Database update also failed:", dbError);
                                }
                            }

                            // Update job status with D-ID URL as fallback
                            jobStatus.set(jobId, {
                                status: 'completed',
                                subtopic: subtopic,
                                videoUrl: videoUrl,
                                subtitleUrl: null,
                                hasSubtitles: false,
                                completedAt: new Date(),
                                questions: questions.length,
                                presenter: presenter_id,
                                storedIn: 'd_id',
                                databaseUpdated: false,
                                error: 'S3 upload failed, using D-ID URL'
                            });
                        }

                    } else {
                        // If video URL is not from D-ID, just use it as is
                        jobStatus.set(jobId, {
                            status: 'completed',
                            subtopic: subtopic,
                            videoUrl: videoUrl,
                            subtitleUrl: null,
                            hasSubtitles: false,
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

// ✅ ADD THIS: IMPROVED Job Status Endpoint
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

        // Calculate elapsed time
        const startedAt = new Date(status.startedAt);
        const now = new Date();
        const elapsedSeconds = Math.floor((now - startedAt) / 1000);

        // Clean up old completed/failed jobs (older than 1 hour)
        if (status.status === 'completed' || status.status === 'failed') {
            if (elapsedSeconds > 3600) {
                jobStatus.delete(jobId);
            }
        }

        res.json({
            success: true,
            ...status,
            elapsed_seconds: elapsedSeconds
        });
    } catch (error) {
        console.error("❌ Job status check failed:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to check job status" 
        });
    }
});

// ✅ WORKING SOLUTION: S3 Upload with Direct MongoDB Save
app.post("/api/upload-to-s3-and-save", async (req, res) => {
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

        console.log("💾 SAVE LESSON: Starting S3 upload and database save");
        console.log("📋 Parameters:", {
            subtopicId: subtopicId,
            parentId: parentId,
            rootId: rootId,
            dbname: dbname,
            subjectName: subjectName,
            subtopicName: subtopic
        });

        if (!videoUrl) {
            return res.status(400).json({
                success: false,
                error: "Missing videoUrl parameter"
            });
        }

        if (!subtopicId) {
            return res.status(400).json({
                success: false,
                error: "Missing subtopicId parameter"
            });
        }

        // Step 1: Upload to S3
        console.log("☁️ Step 1: Uploading to S3...");
        const timestamp = Date.now();
        const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const filename = `video_${safeSubtopicName}_${timestamp}.mp4`;

        let s3Url;
        try {
            s3Url = await uploadToS3(videoUrl, filename);
            console.log("✅ S3 Upload successful:", s3Url);
        } catch (uploadError) {
            console.error("❌ S3 upload failed:", uploadError);
            return res.status(500).json({
                success: false,
                error: "S3 upload failed: " + uploadError.message
            });
        }

        // Step 2: Try Spring Boot first (optional)
        let springBootSuccess = false;
        let springBootResponse = null;
        
        try {
            console.log("🔄 Trying Spring Boot API...");
            springBootResponse = await axios.put(
                "https://dafj1druksig9.cloudfront.net/api/updateSubtopicVideo",
                {
                    subtopicId: subtopicId,
                    aiVideoUrl: s3Url,
                    dbname: dbname,
                    subjectName: subjectName,
                    parentId: parentId,
                    rootId: rootId
                },
                {
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 15000
                }
            );
            
            springBootSuccess = true;
            console.log("✅ Spring Boot success:", springBootResponse.data);
            
        } catch (springBootError) {
            console.log("⚠️ Spring Boot failed, using direct MongoDB update");
        }

        // Step 3: DIRECT MONGODB UPDATE using the fixed function
        console.log("💾 DIRECT MongoDB Update...");
        
        let mongoSaveResult = null;
        
        try {
            mongoSaveResult = await saveVideoToDatabase(s3Url, subtopicId, dbname, subjectName);
            console.log("📊 MongoDB save result:", mongoSaveResult);
        } catch (mongoError) {
            console.error("❌ MongoDB direct update error:", mongoError.message);
            mongoSaveResult = { 
                success: false,
                message: mongoError.message 
            };
        }

        // Step 4: Return response
        const dbUpdated = springBootSuccess || (mongoSaveResult && mongoSaveResult.success);
        
        res.json({
            success: true,
            message: dbUpdated ? 
                "Video uploaded to S3 and saved to database" : 
                "Video uploaded to S3 but database save failed",
            s3_url: s3Url,
            stored_in: "aws_s3",
            database_updated: dbUpdated,
            update_method: springBootSuccess ? "spring_boot" : (mongoSaveResult?.success ? "mongodb_direct" : "failed"),
            spring_boot_success: springBootSuccess,
            mongodb_success: mongoSaveResult?.success || false,
            mongodb_result: mongoSaveResult,
            filename: filename,
            subtopicId: subtopicId,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error("❌ Error in upload-to-s3-and-save:", error);
        res.status(500).json({
            success: false,
            error: "Failed to upload and save: " + error.message
        });
    }
});

// ✅ IMPROVED: Recursive update endpoint
app.put("/api/updateSubtopicVideoRecursive", async (req, res) => {
    try {
        const { subtopicId, parentId, aiVideoUrl, dbname = "professional", subjectName } = req.body;

        console.log("🔄 Recursive update for subtopic:", { subtopicId, parentId, aiVideoUrl, dbname, subjectName });

        if (!subtopicId || !aiVideoUrl) {
            return res.status(400).json({
                error: "Missing subtopicId or aiVideoUrl"
            });
        }

        // Use the same save function
        const saveResult = await saveVideoToDatabase(aiVideoUrl, subtopicId, dbname, subjectName);

        const response = {
            status: "ok",
            success: saveResult.success,
            message: saveResult.message,
            location: saveResult.updateMethod || "not_found",
            collection: saveResult.collection,
            recursive: true
        };

        console.log("📤 Sending response:", response);
        res.json(response);

    } catch (err) {
        console.error("❌ Recursive update error:", err);
        res.status(500).json({
            error: "Recursive update failed: " + err.message
        });
    }
});

// ✅ Original update endpoint for backward compatibility
app.put("/api/updateSubtopicVideo", async (req, res) => {
    try {
        const { subtopicId, parentId, aiVideoUrl, dbname = "professional", subjectName } = req.body;

        console.log("🔄 Original update for subtopic:", { subtopicId, parentId, aiVideoUrl, dbname, subjectName });

        if (!subtopicId || !aiVideoUrl) {
            return res.status(400).json({
                error: "Missing subtopicId or aiVideoUrl"
            });
        }

        // Use the same save function
        const saveResult = await saveVideoToDatabase(aiVideoUrl, subtopicId, dbname, subjectName);

        res.json({
            status: "ok",
            updated: saveResult.success,
            message: saveResult.message,
            location: saveResult.updateMethod || "not_found",
            collection: saveResult.collection
        });

    } catch (err) {
        console.error("❌ Error updating subtopic:", err);
        res.status(500).json({ error: "Failed to update subtopic: " + err.message });
    }
});

// ✅ Debug endpoints
app.get("/api/debug-subtopic/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { dbname = "professional", subjectName } = req.query;

        console.log("🔍 Debugging subtopic:", id);

        const dbConn = getDB(dbname);
        const collections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        let found = false;
        let location = "not_found";
        let collectionFound = "";

        for (const collectionName of collections) {
            const collection = dbConn.collection(collectionName);

            const strategies = [
                { query: { "units._id": id }, location: "nested_units_id" },
                { query: { "units.id": id }, location: "nested_units_string" },
                { query: { "_id": id }, location: "main_document_string" }
            ];

            try {
                if (ObjectId.isValid(id)) {
                    const objectId = new ObjectId(id);
                    strategies.push(
                        { query: { "_id": objectId }, location: "main_document_objectid" },
                        { query: { "units._id": objectId }, location: "nested_units_objectid" }
                    );
                }
            } catch (e) {
                // Ignore ObjectId conversion errors
            }

            for (const strategy of strategies) {
                try {
                    const doc = await collection.findOne(strategy.query);
                    if (doc) {
                        found = true;
                        location = strategy.location;
                        collectionFound = collectionName;
                        console.log(`✅ Found in ${collectionName} using ${strategy.location}`);
                        break;
                    }
                } catch (e) {
                    console.log(`⚠️ Strategy ${strategy.location} failed: ${e.message}`);
                }
            }

            if (found) break;
        }

        res.json({
            found: found,
            location: location,
            collection: collectionFound,
            subtopicId: id
        });

    } catch (err) {
        console.error("❌ Debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ✅ NEW: Debug S3 Configuration Endpoint
app.get("/api/debug-s3", async (req, res) => {
    try {
        const s3Info = {
            bucket: S3_BUCKET_NAME,
            region: process.env.AWS_REGION,
            folder: S3_FOLDER_PATH,
            hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
            hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
            example_url: `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${S3_FOLDER_PATH}filename.mp4`
        };

        res.json(s3Info);
    } catch (error) {
        res.json({
            error: "S3 configuration check failed",
            message: error.message,
            bucket: S3_BUCKET_NAME,
            region: process.env.AWS_REGION
        });
    }
});

// ✅ NEW: List all active jobs
app.get("/api/jobs", (req, res) => {
    try {
        const jobs = Array.from(jobStatus.entries()).map(([jobId, status]) => ({
            jobId,
            ...status
        }));
        
        res.json({
            success: true,
            total: jobs.length,
            jobs: jobs
        });
    } catch (error) {
        console.error("❌ Failed to list jobs:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to list jobs" 
        });
    }
});

// ✅ NEW: Test endpoint to verify database connection and find subtopic
app.get("/api/find-subtopic/:subtopicId", async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const { dbname = "professional", subjectName } = req.query;

        console.log("🔍 Finding subtopic:", subtopicId, "in", subjectName);

        const dbConn = getDB(dbname);
        const collection = dbConn.collection(subjectName);

        // Try multiple query strategies
        const strategies = [
            { query: { "units._id": subtopicId }, location: "nested_units_id" },
            { query: { "units.id": subtopicId }, location: "nested_units_string" },
            { query: { "_id": subtopicId }, location: "main_document_string" },
            { query: { "children._id": subtopicId }, location: "nested_children_id" },
            { query: { "children.id": subtopicId }, location: "nested_children_string" }
        ];

        // Try ObjectId if valid
        if (ObjectId.isValid(subtopicId)) {
            const objectId = new ObjectId(subtopicId);
            strategies.push(
                { query: { "_id": objectId }, location: "main_document_objectid" },
                { query: { "units._id": objectId }, location: "nested_units_objectid" },
                { query: { "children._id": objectId }, location: "nested_children_objectid" }
            );
        }

        let foundDocument = null;
        let foundLocation = "";

        for (const strategy of strategies) {
            try {
                const doc = await collection.findOne(strategy.query);
                if (doc) {
                    foundDocument = doc;
                    foundLocation = strategy.location;
                    console.log(`✅ Found with ${strategy.location}`);
                    break;
                }
            } catch (e) {
                console.log(`⚠️ Strategy ${strategy.location} query error:`, e.message);
            }
        }

        if (foundDocument) {
            // Sanitize the document for response
            const sanitizedDoc = {
                _id: foundDocument._id,
                name: foundDocument.name || foundDocument.subtopic || "Unnamed",
                hasUnits: !!foundDocument.units,
                hasChildren: !!foundDocument.children,
                hasSubtopics: !!foundDocument.subtopics,
                aiVideoUrl: foundDocument.aiVideoUrl || null,
                location: foundLocation
            };

            res.json({
                success: true,
                found: true,
                document: sanitizedDoc,
                collection: subjectName,
                location: foundLocation
            });
        } else {
            res.json({
                success: true,
                found: false,
                message: `Subtopic ${subtopicId} not found in collection ${subjectName}`,
                collection: subjectName,
                strategies_tried: strategies.map(s => s.location)
            });
        }

    } catch (error) {
        console.error("❌ Find subtopic error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "Node.js AI Video Backend with AWS S3 Storage",
        endpoints: [
            "POST /generate-and-upload",
            "POST /api/upload-to-s3-and-save",
            "PUT /api/updateSubtopicVideo",
            "PUT /api/updateSubtopicVideoRecursive",
            "GET /api/debug-subtopic/:id",
            "GET /api/debug-s3",
            "GET /api/job-status/:jobId",
            "GET /api/jobs",
            "GET /health"
        ]
    });
});

// ✅ Test endpoint
app.get("/api/test", (req, res) => {
    res.json({
        message: "Node.js backend is working!",
        features: "AI Video Generation with AWS S3 Storage",
        timestamp: new Date().toISOString()
    });
});

// ✅ Create assets directory on startup
function ensureAssetsDirectory() {
    const assetsDir = path.join(__dirname, 'assets', 'ai_video');
    if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
        console.log("📁 Created assets directory:", assetsDir);
    } else {
        console.log("✅ Assets directory exists:", assetsDir);
    }
}

// ✅ Catch-all for undefined routes
app.use("*", (req, res) => {
    res.status(404).json({
        error: "Endpoint not found",
        path: req.originalUrl,
        method: req.method,
        availableEndpoints: [
            "POST /generate-and-upload",
            "POST /api/upload-to-s3-and-save",
            "PUT /api/updateSubtopicVideo",
            "PUT /api/updateSubtopicVideoRecursive",
            "GET /api/debug-subtopic/:id",
            "GET /api/debug-s3",
            "GET /api/job-status/:jobId",
            "GET /api/jobs",
            "GET /health",
            "GET /api/test"
        ]
    });
});

// ✅ Start server
ensureAssetsDirectory();
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Node.js Server running on http://0.0.0.0:${PORT}`);
    console.log(`☁️ AWS S3 Storage Enabled: Videos will be saved to ${S3_BUCKET_NAME}/${S3_FOLDER_PATH}`);
    console.log(`✅ Available Endpoints:`);
    console.log(`   POST /generate-and-upload (Async - No 504 errors)`);
    console.log(`   POST /api/upload-to-s3-and-save`);
    console.log(`   PUT /api/updateSubtopicVideo`);
    console.log(`   PUT /api/updateSubtopicVideoRecursive`);
    console.log(`   GET /api/debug-subtopic/:id`);
    console.log(`   GET /api/debug-s3`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   GET /api/jobs`);
    console.log(`   GET /health`);
    console.log(`   GET /api/test`);
});
