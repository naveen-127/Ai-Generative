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
    req.setTimeout(300000); // 5 minutes
    res.setTimeout(300000); // 5 minutes
    next();
});

// ✅ AWS S3 Configuration
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1', // Changed to match your bucket region
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations-test-admin';
const S3_FOLDER_PATH = 'subtopics/ai_videourl/'; // Fixed path

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

// ✅ IMPROVED: Recursive helper function to update nested subtopics
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

        // Recursively search in child arrays
        const childArrays = ['children', 'units', 'subtopics', 'lessons', 'topics'];
        for (const arrayName of childArrays) {
            if (subtopic[arrayName] && Array.isArray(subtopic[arrayName])) {
                const found = updateNestedSubtopicRecursive(subtopic[arrayName], targetId, aiVideoUrl);
                if (found) return true;
            }
        }
    }
    return false;
}

// ✅ NEW: Helper function for direct subtopic update
// ✅ FIXED: Helper function for direct subtopic update
async function updateDirectSubtopic(collection, subtopicId, videoUrl) {
    const strategies = [
        // Strategy 1: Update main document if subtopicId matches _id
        { query: { "_id": subtopicId }, location: "main_document_string" },
        { query: { "id": subtopicId }, location: "main_document_id" },
        
        // Strategy 2: Update in units array using _id
        { query: { "units._id": subtopicId }, 
          update: { $set: { "units.$.aiVideoUrl": videoUrl, "units.$.updatedAt": new Date() } },
          location: "nested_units_string" },
        
        // Strategy 3: Update in units array using id field
        { query: { "units.id": subtopicId }, 
          update: { $set: { "units.$.aiVideoUrl": videoUrl, "units.$.updatedAt": new Date() } },
          location: "nested_units_id" }
    ];

    // Try ObjectId if possible
    try {
        const objectId = new ObjectId(subtopicId);
        strategies.push(
            // Strategy 4: Main document with ObjectId
            { query: { "_id": objectId }, location: "main_document_objectid" },
            
            // Strategy 5: Nested units with ObjectId
            { query: { "units._id": objectId }, 
              update: { $set: { "units.$.aiVideoUrl": videoUrl, "units.$.updatedAt": new Date() } },
              location: "nested_units_objectid" }
        );
    } catch (e) {
        console.log(`⚠️ Cannot convert to ObjectId: ${e.message}`);
    }

    for (const strategy of strategies) {
        try {
            console.log(`🔍 Trying direct update strategy: ${strategy.location}`);
            
            let result;
            if (strategy.update) {
                // For array updates (units.$.field)
                result = await collection.updateOne(strategy.query, strategy.update);
            } else {
                // For main document updates
                result = await collection.updateOne(
                    strategy.query,
                    {
                        $set: {
                            aiVideoUrl: videoUrl,
                            updatedAt: new Date(),
                            videoStorage: videoUrl.includes('amazonaws.com') ? "aws_s3" : "d_id",
                            s3Path: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                        }
                    }
                );
            }

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

// ✅ NEW: Helper function for recursive subtopic update
async function updateRecursiveSubtopic(collection, subtopicId, videoUrl) {
    try {
        const documents = await collection.find({
            $or: [
                { "units": { $exists: true } },
                { "children": { $exists: true } },
                { "subtopics": { $exists: true } }
            ]
        }).toArray();

        console.log(`📄 Found ${documents.length} documents with nested structures`);

        for (const doc of documents) {
            // Check units array
            if (doc.units && Array.isArray(doc.units)) {
                const unitsCopy = JSON.parse(JSON.stringify(doc.units));
                const foundInUnits = updateNestedSubtopicRecursive(unitsCopy, subtopicId, videoUrl);

                if (foundInUnits) {
                    await collection.updateOne(
                        { _id: doc._id },
                        {
                            $set: {
                                units: unitsCopy
                            }
                        }
                    );
                    return { updated: true, location: "nested_units" };
                }
            }

            // Check children array
            if (doc.children && Array.isArray(doc.children)) {
                const childrenCopy = JSON.parse(JSON.stringify(doc.children));
                const foundInChildren = updateNestedSubtopicRecursive(childrenCopy, subtopicId, videoUrl);

                if (foundInChildren) {
                    await collection.updateOne(
                        { _id: doc._id },
                        {
                            $set: {
                                children: childrenCopy
                            }
                        }
                    );
                    return { updated: true, location: "nested_children" };
                }
            }

            // Check subtopics array
            if (doc.subtopics && Array.isArray(doc.subtopics)) {
                const subtopicsCopy = JSON.parse(JSON.stringify(doc.subtopics));
                const foundInSubtopics = updateNestedSubtopicRecursive(subtopicsCopy, subtopicId, videoUrl);

                if (foundInSubtopics) {
                    await collection.updateOne(
                        { _id: doc._id },
                        {
                            $set: {
                                subtopics: subtopicsCopy
                            }
                        }
                    );
                    return { updated: true, location: "nested_subtopics" };
                }
            }
        }

        return { updated: false };
    } catch (error) {
        console.error("❌ Recursive update error:", error);
        return { updated: false };
    }
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

// ✅ AWS S3 Upload Function - WITH BETTER ERROR HANDLING
// ✅ AWS S3 Upload Function - UPDATED
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("☁️ Uploading to AWS S3...");
        console.log("📁 Bucket:", S3_BUCKET_NAME);
        console.log("📁 Region:", process.env.AWS_REGION || 'ap-south-1');
        console.log("📁 Folder:", S3_FOLDER_PATH);
        console.log("📄 Filename:", filename);
        console.log("📥 Source URL:", videoUrl);
        
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
            // Removed ACL if bucket policy already handles it
            // ACL: 'public-read',
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

        // Test if URL is accessible
        try {
            const testResponse = await axios.head(s3Url);
            console.log("✅ S3 URL is accessible, Status:", testResponse.status);
        } catch (testError) {
            console.warn("⚠️ S3 URL might not be publicly accessible:", testError.message);
            console.log("💡 Check S3 bucket permissions or CORS configuration");
        }

        return s3Url;
    } catch (error) {
        console.error("❌ Upload to S3 failed with details:");
        console.error("   Error Name:", error.name);
        console.error("   Error Message:", error.message);
        console.error("   Error Code:", error.Code || error.code);
        console.error("   Error Status:", error.$metadata?.httpStatusCode);
        
        // More detailed error information
        if (error.name === 'CredentialsProviderError') {
            console.error("   ❌ AWS Credentials Error: Check .env file");
            console.error("   Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY");
        } else if (error.name === 'AccessDenied') {
            console.error("   ❌ Access Denied: IAM user needs PutObject permission");
            console.error("   Required S3 permissions: s3:PutObject, s3:GetObject");
        } else if (error.name === 'NoSuchBucket') {
            console.error("   ❌ Bucket not found:", S3_BUCKET_NAME);
            console.error("   Create bucket in region:", process.env.AWS_REGION);
        } else if (error.response) {
            console.error("   ❌ Download Error Status:", error.response.status);
            console.error("   ❌ Download Error Data:", error.response.data);
        }
        
        throw new Error(`S3 upload failed: ${error.message}`);
    }
}

// ✅ FIXED: S3 Upload and Save to Database Endpoint
// ✅ FIXED: S3 Upload and Save to Database Endpoint with Better Debugging
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

        // Step 2: Save to Database
        console.log("💾 Step 2: Saving to database...");
        const dbConn = getDB(dbname);
        
        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";
        let stored_in = "aws_s3";

        // Get target collection - IMPORTANT: Use subjectName as collection
        if (!subjectName || subjectName.trim() === "") {
            console.error("❌ SubjectName is required but not provided");
            return res.status(400).json({
                success: false,
                error: "subjectName parameter is required"
            });
        }
        
        const targetCollection = subjectName.trim();
        console.log(`🔍 Using collection: ${targetCollection}`);

        const collection = dbConn.collection(targetCollection);
        
        // DEBUG: First check what's in the collection
        try {
            console.log("🔍 DEBUG: Checking collection structure...");
            const sampleDoc = await collection.findOne({});
            if (sampleDoc) {
                console.log("📄 Sample document structure:");
                console.log("  _id:", sampleDoc._id);
                console.log("  has units array:", Array.isArray(sampleDoc.units));
                if (Array.isArray(sampleDoc.units)) {
                    console.log("  units count:", sampleDoc.units.length);
                    sampleDoc.units.forEach((unit, index) => {
                        console.log(`  Unit ${index}: _id=${unit._id}, unitName=${unit.unitName}`);
                    });
                }
            }
        } catch (debugErr) {
            console.log("⚠️ Debug check failed:", debugErr.message);
        }

        // Try to find and update the subtopic
        console.log(`🔍 Looking for subtopic with ID: ${subtopicId}`);
        
        // Strategy 1: Check if it's a main document
        const mainDoc = await collection.findOne({ _id: subtopicId });
        if (mainDoc) {
            console.log("✅ Found as main document");
            await collection.updateOne(
                { _id: subtopicId },
                {
                    $set: {
                        aiVideoUrl: s3Url,
                        updatedAt: new Date(),
                        videoStorage: "aws_s3",
                        s3Path: s3Url.split('.com/')[1]
                    }
                }
            );
            updated = true;
            updateLocation = "main_document";
        }
        
        // Strategy 2: Check if it's in units array (most likely for your structure)
        if (!updated) {
            console.log("🔍 Searching in units array...");
            const query = { "units._id": subtopicId };
            const result = await collection.updateOne(
                query,
                {
                    $set: {
                        "units.$.aiVideoUrl": s3Url,
                        "units.$.updatedAt": new Date(),
                        "units.$.videoStorage": "aws_s3",
                        "units.$.s3Path": s3Url.split('.com/')[1]
                    }
                }
            );
            
            if (result.matchedCount > 0) {
                updated = true;
                updateLocation = "nested_units_array";
                console.log(`✅ Updated in units array. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
            }
        }
        
        // Strategy 3: Try with ObjectId
        if (!updated) {
            try {
                const objectId = new ObjectId(subtopicId);
                console.log("🔍 Trying with ObjectId conversion...");
                
                // Try as main document with ObjectId
                const result1 = await collection.updateOne(
                    { _id: objectId },
                    {
                        $set: {
                            aiVideoUrl: s3Url,
                            updatedAt: new Date(),
                            videoStorage: "aws_s3",
                            s3Path: s3Url.split('.com/')[1]
                        }
                    }
                );
                
                if (result1.matchedCount > 0) {
                    updated = true;
                    updateLocation = "main_document_objectid";
                }
                
                // Try in units array with ObjectId
                if (!updated) {
                    const result2 = await collection.updateOne(
                        { "units._id": objectId },
                        {
                            $set: {
                                "units.$.aiVideoUrl": s3Url,
                                "units.$.updatedAt": new Date(),
                                "units.$.videoStorage": "aws_s3",
                                "units.$.s3Path": s3Url.split('.com/')[1]
                            }
                        }
                    );
                    
                    if (result2.matchedCount > 0) {
                        updated = true;
                        updateLocation = "nested_units_objectid";
                    }
                }
            } catch (objectIdErr) {
                console.log("⚠️ ObjectId conversion failed:", objectIdErr.message);
            }
        }

        if (!updated) {
            console.log("⚠️ Could not find subtopic in the collection");
            stored_in = "s3_only_not_in_db";
            
            // Try one more approach - search all documents
            console.log("🔍 Last attempt: Searching all documents...");
            const allDocs = await collection.find({}).toArray();
            for (const doc of allDocs) {
                if (doc.units && Array.isArray(doc.units)) {
                    for (let i = 0; i < doc.units.length; i++) {
                        const unit = doc.units[i];
                        if (unit._id === subtopicId || unit.id === subtopicId) {
                            // Found it - update using array index
                            const updatePath = `units.${i}`;
                            await collection.updateOne(
                                { _id: doc._id },
                                {
                                    $set: {
                                        [`${updatePath}.aiVideoUrl`]: s3Url,
                                        [`${updatePath}.updatedAt`]: new Date(),
                                        [`${updatePath}.videoStorage`]: "aws_s3",
                                        [`${updatePath}.s3Path`]: s3Url.split('.com/')[1]
                                    }
                                }
                            );
                            updated = true;
                            updateLocation = "found_using_index_search";
                            console.log(`✅ Found and updated using index ${i}`);
                            break;
                        }
                    }
                }
                if (updated) break;
            }
        }

        console.log("✅ Database update result:", {
            updated: updated,
            location: updateLocation,
            collection: targetCollection,
            s3Url: s3Url
        });

        // Verify the update worked
        if (updated) {
            console.log("🔍 Verifying update...");
            try {
                // Check if it was saved in units array
                const verifyQuery = { "units._id": subtopicId };
                const verifyDoc = await collection.findOne(verifyQuery);
                if (verifyDoc && verifyDoc.units) {
                    const updatedUnit = verifyDoc.units.find(u => u._id === subtopicId);
                    if (updatedUnit && updatedUnit.aiVideoUrl === s3Url) {
                        console.log("✅ Verification PASSED: Video URL saved correctly");
                    } else {
                        console.log("⚠️ Verification: Found document but aiVideoUrl doesn't match");
                    }
                }
            } catch (verifyErr) {
                console.log("⚠️ Verification failed:", verifyErr.message);
            }
        }

        // Return success response
        res.json({
            success: true,
            message: updated ? "Video uploaded to S3 and saved to database" : "Video uploaded to S3 but subtopic not found in database",
            s3_url: s3Url,
            stored_in: stored_in,
            database_updated: updated,
            update_location: updateLocation,
            collection: targetCollection,
            filename: filename,
            subtopicId: subtopicId
        });

    } catch (error) {
        console.error("❌ Error in upload-to-s3-and-save:", error);
        res.status(500).json({
            success: false,
            error: "Failed to upload and save: " + error.message,
            stack: error.stack
        });
    }
});

// ✅ FIXED: Job status tracking at the top
const jobStatus = new Map();

// ✅ Async video generation with immediate response
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

        // ✅ RETURN IMMEDIATE RESPONSE to avoid CloudFront timeout
        res.json({
            status: "processing",
            message: "AI video generation started",
            job_id: jobId,
            subtopic: subtopic,
            questions_count: questions.length,
            presenter_used: presenter_id,
            note: "Video is being generated and will be automatically uploaded to AWS S3. This may take 2-3 minutes."
        });

        // ✅ PROCESS IN BACKGROUND WITH ALL PARAMETERS
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
        res.status(500).json({
            error: "Failed to start video generation: " + err.message
        });
    }
});

// ✅ Background video processing with automatic S3 upload and DB save
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

                    // ✅ AUTOMATICALLY UPLOAD TO S3 AND SAVE TO DB
                    if (videoUrl && videoUrl.includes('d-id.com')) {
                        console.log("☁️ Starting automatic S3 upload...");

                        jobStatus.set(jobId, {
                            ...jobStatus.get(jobId),
                            progress: 'Uploading to AWS S3...'
                        });

                        try {
                            // Generate unique filename for S3
                            const timestamp = Date.now();
                            const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
                            const filename = `video_${safeSubtopicName}_${timestamp}.mp4`;

                            console.log("📄 Uploading to S3 with filename:", filename);

                            // Upload to AWS S3
                            const s3Url = await uploadToS3(videoUrl, filename);
                            console.log("✅ S3 Upload successful:", s3Url);

                            // ✅ AUTOMATICALLY SAVE S3 URL TO DATABASE
                            if (s3Url && subtopicId) {
                                console.log("💾 Automatically saving S3 URL to database...");
                                console.log("🔗 S3 URL to save:", s3Url);

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                // Save to database using recursive update
                                const dbConn = getDB(dbname);
                                
                                let targetCollections = [];
                                if (subjectName && subjectName.trim() !== "") {
                                    targetCollections = [subjectName.trim()];
                                } else {
                                    targetCollections = await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));
                                }

                                let updated = false;
                                let updateLocation = "not_found";
                                let updatedCollection = "unknown";

                                console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);

                                for (const collectionName of targetCollections) {
                                    const collection = dbConn.collection(collectionName);
                                    console.log(`🔍 Processing collection: ${collectionName}`);

                                    // Try direct update first
                                    const directUpdate = await updateDirectSubtopic(collection, subtopicId, s3Url);
                                    if (directUpdate.updated) {
                                        updated = true;
                                        updateLocation = directUpdate.location;
                                        updatedCollection = collectionName;
                                        console.log(`✅ Direct update successful: ${updateLocation}`);
                                        break;
                                    }

                                    // Try recursive update in nested structures
                                    const recursiveUpdate = await updateRecursiveSubtopic(collection, subtopicId, s3Url);
                                    if (recursiveUpdate.updated) {
                                        updated = true;
                                        updateLocation = recursiveUpdate.location;
                                        updatedCollection = collectionName;
                                        console.log(`✅ Recursive update successful: ${updateLocation}`);
                                        break;
                                    }
                                }

                                if (updated) {
                                    console.log(`✅ S3 URL saved to database in ${updatedCollection} at ${updateLocation}`);

                                    // ✅ FINAL: Update job status with S3 URL
                                    jobStatus.set(jobId, {
                                        status: 'completed',
                                        subtopic: subtopic,
                                        videoUrl: s3Url,
                                        completedAt: new Date(),
                                        questions: questions.length,
                                        presenter: presenter_id,
                                        storedIn: 'aws_s3',
                                        databaseUpdated: updated,
                                        updateLocation: updateLocation,
                                        collection: updatedCollection,
                                        s3Url: s3Url
                                    });

                                } else {
                                    console.log("⚠️ S3 URL generated but subtopic not found in database");
                                    // Still complete the job but mark as not updated in DB
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

                            // If S3 upload fails, fall back to D-ID URL and try to save that
                            console.log("🔄 Falling back to D-ID URL for database");

                            if (subtopicId) {
                                try {
                                    const dbConn = getDB(dbname);
                                    let targetCollections = [];
                                    if (subjectName && subjectName.trim() !== "") {
                                        targetCollections = [subjectName.trim()];
                                    } else {
                                        targetCollections = await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));
                                    }

                                    for (const collectionName of targetCollections) {
                                        const collection = dbConn.collection(collectionName);
                                        const directUpdate = await updateDirectSubtopic(collection, subtopicId, videoUrl);
                                        if (directUpdate.updated) break;
                                    }
                                } catch (dbError) {
                                    console.error("❌ Database update also failed:", dbError);
                                }
                            }

                            // Update job status with D-ID URL as fallback
                            jobStatus.set(jobId, {
                                status: 'completed',
                                subtopic: subtopic,
                                videoUrl: videoUrl, // Fallback to D-ID URL
                                completedAt: new Date(),
                                questions: questions.length,
                                presenter: presenter_id,
                                storedIn: 'd_id',
                                databaseUpdated: false,
                                error: 'S3 upload failed, using D-ID URL'
                            });
                        }

                    } else {
                        // If video URL is not from D-ID (shouldn't happen), just use it as is
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

// ✅ ADD THIS: Job Status Endpoint
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

// ✅ IMPROVED: Recursive update that also updates main subtopics
app.put("/api/updateSubtopicVideoRecursive", async (req, res) => {
    try {
        const { subtopicId, parentId, aiVideoUrl, dbname = "professional", subjectName } = req.body;

        console.log("🔄 Recursive update for subtopic:", { subtopicId, parentId, aiVideoUrl, dbname, subjectName });

        if (!subtopicId || !aiVideoUrl) {
            return res.status(400).json({
                error: "Missing subtopicId or aiVideoUrl"
            });
        }

        const dbConn = getDB(dbname);
        const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";

        console.log(`🔍 Starting recursive search in collections: ${targetCollections.join(', ')}`);

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            console.log(`🔍 Recursive search in collection: ${collectionName}`);

            // ✅ FIXED: FIRST try to update MAIN subtopic directly
            console.log("🔍 FIRST: Trying to update MAIN subtopic directly...");
            const directStrategies = [
                { query: { "_id": subtopicId }, updateField: "aiVideoUrl" },
                { query: { "id": subtopicId }, updateField: "aiVideoUrl" }
            ];

            try {
                directStrategies.push({
                    query: { "_id": new ObjectId(subtopicId) },
                    updateField: "aiVideoUrl"
                });
            } catch (e) {
                console.log(`⚠️ Cannot convert ${subtopicId} to ObjectId: ${e.message}`);
            }

            for (const strategy of directStrategies) {
                try {
                    console.log(`🔍 Trying direct main subtopic update: ${JSON.stringify(strategy.query)}`);
                    const result = await collection.updateOne(
                        strategy.query,
                        {
                            $set: {
                                [strategy.updateField]: aiVideoUrl,
                                updatedAt: new Date()
                            }
                        }
                    );

                    if (result.matchedCount > 0) {
                        updated = true;
                        updateLocation = `main_subtopic_${strategy.query._id ? 'objectid' : 'string'}`;
                        updatedCollection = collectionName;
                        console.log(`✅ Updated MAIN subtopic directly: ${updateLocation}, matched: ${result.matchedCount}`);
                        break;
                    }
                } catch (e) {
                    console.log(`⚠️ Direct main subtopic strategy failed: ${e.message}`);
                }
            }

            if (updated) break;

            // ✅ SECOND: If main subtopic not found, search in nested structures
            console.log("🔍 SECOND: Searching in nested structures...");
            const documents = await collection.find({
                $or: [
                    { "units": { $exists: true } },
                    { "children": { $exists: true } },
                    { "subtopics": { $exists: true } }
                ]
            }).toArray();

            console.log(`📄 Found ${documents.length} documents with nested structures in ${collectionName}`);

            for (const doc of documents) {
                if (doc.units && Array.isArray(doc.units)) {
                    const unitsCopy = JSON.parse(JSON.stringify(doc.units));
                    const foundInUnits = updateNestedSubtopicRecursive(unitsCopy, subtopicId, aiVideoUrl);

                    if (foundInUnits) {
                        const updateResult = await collection.updateOne(
                            { _id: doc._id },
                            { $set: { units: unitsCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_units";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested units of ${collectionName}, document: ${doc._id}`);
                        break;
                    }
                }

                if (updated) break;

                if (doc.children && Array.isArray(doc.children)) {
                    const childrenCopy = JSON.parse(JSON.stringify(doc.children));
                    const foundInChildren = updateNestedSubtopicRecursive(childrenCopy, subtopicId, aiVideoUrl);

                    if (foundInChildren) {
                        const updateResult = await collection.updateOne(
                            { _id: doc._id },
                            { $set: { children: childrenCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_children";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested children of ${collectionName}, document: ${doc._id}`);
                        break;
                    }
                }

                if (updated) break;

                if (doc.subtopics && Array.isArray(doc.subtopics)) {
                    const subtopicsCopy = JSON.parse(JSON.stringify(doc.subtopics));
                    const foundInSubtopics = updateNestedSubtopicRecursive(subtopicsCopy, subtopicId, aiVideoUrl);

                    if (foundInSubtopics) {
                        const updateResult = await collection.updateOne(
                            { _id: doc._id },
                            { $set: { subtopics: subtopicsCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_subtopics";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested subtopics of ${collectionName}, document: ${doc._id}`);
                        break;
                    }
                }

                if (updated) break;
            }

            if (updated) break;
        }

        const response = {
            status: "ok",
            updated: updated,
            location: updateLocation,
            collection: updatedCollection,
            recursive: true,
            message: updated ? "AI video URL saved recursively" : "Subtopic not found in any nested structure"
        };

        console.log("📤 Sending response:", response);
        res.json(response);

    } catch (err) {
        console.error("❌ Recursive update error:", err);
        res.status(500).json({
            error: "Recursive update failed: " + err.message,
            details: "Check server logs for more information"
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

        const dbConn = getDB(dbname);
        let result;
        let updateLocation = "unknown";
        let updatedCollection = "unknown";

        const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            console.log(`🔍 Attempting update in collection: ${collectionName}`);

            const strategies = [
                {
                    name: "nested_unit_string",
                    query: { "units._id": subtopicId },
                    update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } }
                },
                {
                    name: "nested_unit_id",
                    query: { "units.id": subtopicId },
                    update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } }
                },
                {
                    name: "main_document_string",
                    query: { _id: subtopicId },
                    update: { $set: { aiVideoUrl: aiVideoUrl, updatedAt: new Date() } }
                }
            ];

            try {
                strategies.push(
                    {
                        name: "nested_unit_ObjectId",
                        query: { "units._id": new ObjectId(subtopicId) },
                        update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } }
                    },
                    {
                        name: "main_document_ObjectId",
                        query: { _id: new ObjectId(subtopicId) },
                        update: { $set: { aiVideoUrl: aiVideoUrl, updatedAt: new Date() } }
                    }
                );
            } catch (e) {
                console.log(`⚠️ Cannot use ObjectId for ${subtopicId}: ${e.message}`);
            }

            for (const strategy of strategies) {
                try {
                    console.log(`🔍 Trying strategy: ${strategy.name}`);
                    result = await collection.updateOne(strategy.query, strategy.update);

                    if (result.matchedCount > 0) {
                        updateLocation = strategy.name;
                        updatedCollection = collectionName;
                        console.log(`✅ Updated using ${strategy.name} in ${collectionName}`);
                        break;
                    }
                } catch (e) {
                    console.log(`⚠️ Strategy ${strategy.name} failed: ${e.message}`);
                }
            }

            if (result && result.matchedCount > 0) break;
        }

        if (!result || result.matchedCount === 0) {
            return res.status(404).json({
                error: "Subtopic not found",
                subtopicId: subtopicId,
                suggestion: "Try using the recursive update endpoint for nested subtopics"
            });
        }

        res.json({
            status: "ok",
            updated: result.modifiedCount,
            matched: result.matchedCount,
            location: updateLocation,
            collection: updatedCollection,
            message: "AI video URL saved successfully"
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
                { query: { "_id": id }, location: "main_document_string" },
                { query: { "_id": new ObjectId(id) }, location: "main_document_objectid" }
            ];

            for (const strategy of strategies) {
                try {
                    const doc = await collection.findOne(strategy.query);
                    if (doc) {
                        found = true;
                        location = strategy.location;
                        collectionFound = collectionName;
                        break;
                    }
                } catch (e) {
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
    console.log(`   GET /health`);
    console.log(`   GET /api/test`);
});
