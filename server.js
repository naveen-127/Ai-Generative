const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const FormData = require('form-data');
const fs = require("fs");
const { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const config = require('./config');

const app = express();
const PORT = config.port || 3000;

// Add this near your other routes in server.js (around line 400)
app.get('/api/config', (req, res) => {
    res.json({
        aiUrl: config.aiUrl,
        springBootUrl: config.springBootUrl
    });
});

// ✅ ADD THIS: Increase server timeouts to prevent 504 errors
app.use((req, res, next) => {
    // Add request start time
    req.startTime = Date.now();
    // Skip timeout for health checks
    if (req.path === '/health' || req.path === '/api/ping' || req.path === '/api/test') {
        // Quick health checks
        req.setTimeout(5000);
        res.setTimeout(5000);
    } else if (req.path === '/generate-and-upload') {
        // Video generation - returns immediately
        req.setTimeout(15000);
        res.setTimeout(15000);
    } else if (req.path === '/api/upload-to-s3-and-save') {
        // S3 upload can take time
        req.setTimeout(120000); // 2 minutes
        res.setTimeout(120000);
    } else {
        // Default for other endpoints
        req.setTimeout(30000);
        res.setTimeout(30000);
    }

    // Add timeout error handler
    req.on('timeout', () => {
        console.error(`❌ Request timeout: ${req.method} ${req.url} after ${Date.now() - req.startTime}ms`);
        if (!res.headersSent) {
            res.status(504).json({
                error: "Gateway Timeout",
                message: "Server took too long to respond",
                timeout: Date.now() - req.startTime
            });
        }
    });

    next();
});

// Add this near your other middleware (around line 50-60)
app.use(express.json({
    limit: '50mb',
    verify: (req, res, buf) => {
        try {
            // Store raw body for debugging if needed
            req.rawBody = buf.toString();
        } catch (e) {
            console.error("Error parsing raw body:", e);
        }
    }
}));

app.use((req, res, next) => {
    res.setHeader('Keep-Alive', 'timeout=60, max=100');
    res.setHeader('Connection', 'keep-alive');
    next();
});

// ✅ AWS S3 Configuration
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1'
    // NO credentials needed when using IAM Role!
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations-test-admin';
const S3_BASE_FOLDER = 'subtopics/aivideospath';

function sanitizeForS3Path(str) {
    if (!str) return 'unnamed';
    return str
        .replace(/[^a-zA-Z0-9\-_\s]/g, '_')  // Replace special chars with underscore
        .replace(/\s+/g, '_')                // Replace spaces with underscore
        .replace(/_+/g, '_')                // Replace multiple underscores with single
        .replace(/^_+|_+$/g, '')            // Remove leading/trailing underscores
        .substring(0, 50);                  // Limit length
}

// ✅ Generate dynamic S3 path - S3 will auto-create folders
function generateS3Path(standard, subject, lesson, topic) {
    // Sanitize each component
    const sanitizedStandard = sanitizeForS3Path(standard || 'no_standard');
    const sanitizedSubject = sanitizeForS3Path(subject || 'no_subject');
    const sanitizedLesson = sanitizeForS3Path(lesson || 'no_lesson');
    const sanitizedTopic = sanitizeForS3Path(topic || 'no_topic');

    // Handle special subjects (NEET, JEE, etc.)
    const subjectsWithoutStandard = ['NEET_Previous_Questions', 'Formulas', 'JEE_Previous_Questions'];
    if (subjectsWithoutStandard.includes(sanitizedSubject) || !standard || standard === 'special') {
        return `${S3_BASE_FOLDER}/no_standard/${sanitizedSubject}/${sanitizedLesson}/${sanitizedTopic}/`;
    }

    // For normal subjects with standard
    return `${S3_BASE_FOLDER}/standard_${sanitizedStandard}/${sanitizedSubject}/${sanitizedLesson}/${sanitizedTopic}/`;
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
    "https://ai-generative-1.onrender.com",
     config.aiUrl,
    "http://localhost:80"
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, etc)
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
    maxAge: 86400 // Cache preflight for 24 hours
}));

// ✅ NO ADDITIONAL CORS MIDDLEWARE AFTER THIS
// REMOVE: app.options('*', cors()) - NOT NEEDED, cors() handles OPTIONS
// REMOVE: The manual header middleware below

// Keep these - they're fine
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

// ✅ NEW: Enhanced recursive search function
async function findSubtopicInDatabase(subtopicId, dbname, subjectName) {
    console.log("🔍 Enhanced search for subtopic:", subtopicId);
    const dbConn = getDB(dbname);
    const collection = dbConn.collection(subjectName);

    // Define all possible array fields
    const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

    // Try different search strategies
    const searchStrategies = [];

    // Strategy 1: Direct ID matches
    searchStrategies.push({ query: { "_id": subtopicId }, type: "direct_id" });
    searchStrategies.push({ query: { "id": subtopicId }, type: "direct_string_id" });

    // Strategy 2: Search in all array fields
    for (const field of arrayFields) {
        searchStrategies.push({ query: { [`${field}._id`]: subtopicId }, type: `${field}_id` });
        searchStrategies.push({ query: { [`${field}.id`]: subtopicId }, type: `${field}_string_id` });
    }

    // Strategy 3: Try ObjectId if valid
    if (ObjectId.isValid(subtopicId)) {
        const objectId = new ObjectId(subtopicId);
        searchStrategies.push({ query: { "_id": objectId }, type: "direct_objectid" });

        for (const field of arrayFields) {
            searchStrategies.push({ query: { [`${field}._id`]: objectId }, type: `${field}_objectid` });
        }
    }

    // Execute search strategies
    for (const strategy of searchStrategies) {
        try {
            const result = await collection.findOne(strategy.query);
            if (result) {
                console.log(`✅ Found with strategy: ${strategy.type}`);
                return {
                    found: true,
                    document: result,
                    strategy: strategy.type,
                    isMainDocument: strategy.type.includes('direct')
                };
            }
        } catch (error) {
            console.log(`⚠️ Strategy ${strategy.type} failed:`, error.message);
        }
    }

    // Strategy 4: Recursive search in all documents
    console.log("🔄 Starting recursive search in all documents...");
    const allDocuments = await collection.find({}).toArray();

    for (const document of allDocuments) {
        // Check if subtopic is in this document's nested structures
        const foundPath = findInNestedStructure(document, subtopicId);
        if (foundPath) {
            return {
                found: true,
                document: document,
                strategy: "recursive_search",
                foundPath: foundPath,
                isMainDocument: false
            };
        }
    }

    return {
        found: false,
        message: "Subtopic not found in any nested structure"
    };
}

// ✅ NEW: Helper to find subtopic in nested structure
function findInNestedStructure(obj, targetId, path = '') {
    if (!obj || typeof obj !== 'object') return null;

    // Check current object
    if ((obj._id && obj._id.toString() === targetId) ||
        (obj.id && obj.id.toString() === targetId)) {
        return path || 'root';
    }

    // Check all array fields
    const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

    for (const field of arrayFields) {
        if (Array.isArray(obj[field])) {
            for (let i = 0; i < obj[field].length; i++) {
                const item = obj[field][i];
                const newPath = path ? `${path}.${field}[${i}]` : `${field}[${i}]`;

                // Check item directly
                if ((item._id && item._id.toString() === targetId) ||
                    (item.id && item.id.toString() === targetId)) {
                    return newPath;
                }

                // Recursively search deeper
                const deeperPath = findInNestedStructure(item, targetId, newPath);
                if (deeperPath) return deeperPath;
            }
        }
    }

    return null;
}

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

// ✅ D-ID Logo Upload Function
async function uploadLogoToDID(logoFilePath, top = "0", left = "-120") {
    try {
        console.log("🖼️ Uploading logo to D-ID...");
        console.log("📁 Logo file:", logoFilePath);

        // Check if file exists
        if (!fs.existsSync(logoFilePath)) {
            throw new Error(`Logo file not found: ${logoFilePath}`);
        }

        // Import FormData properly
        const FormData = require('form-data');
        const formData = new FormData();

        // Read the file as a stream
        const fileStream = fs.createReadStream(logoFilePath);
        formData.append('logo', fileStream);
        formData.append('top', top);
        formData.append('left', left);

        // Get headers properly
        const headers = formData.getHeaders();

        // Make API request to D-ID
        const response = await axios.post(
            "https://api.d-id.com/settings/logo",
            formData,
            {
                headers: {
                    ...headers,
                    'Authorization': DID_API_KEY,
                    'Accept': 'application/json'
                },
                timeout: 30000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log("✅ Logo uploaded successfully to D-ID");
        console.log("📊 Response:", response.data);

        return {
            success: true,
            data: response.data,
            message: "Logo uploaded successfully"
        };

    } catch (error) {
        console.error("❌ Logo upload failed:");

        if (error.response) {
            console.error("   Status:", error.response.status);
            console.error("   Data:", error.response.data);
            console.error("   Headers:", error.response.headers);

            return {
                success: false,
                status: error.response.status,
                error: error.response.data,
                message: `D-ID API error: ${error.response.status}`
            };
        } else if (error.request) {
            console.error("   No response received:", error.request);
            return {
                success: false,
                error: "No response from D-ID API",
                message: "Network error - no response received"
            };
        } else {
            console.error("   Error:", error.message);
            return {
                success: false,
                error: error.message,
                message: "Request setup failed"
            };
        }
    }
}

function getVoiceForPresenter(presenter_id) {
    const voiceMap = {
        "v2_public_anita_pink_shirt_green_screen@pw9Otj5BPp": "en-IN-AartiNeural",
        "v2_public_Rian_NoHands_WhiteTshirt_Home@fJyZiHrDxU": "en-US-RyanMultilingualNeural",
        // Keep the old ones for backward compatibility
        "v2_public_anita@Os4oKCBIgZ": "en-IN-NeerjaNeural",
        "v2_public_lucas@vngv2djh6d": "en-US-GuyNeural",
        "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r": "en-GB-RyanNeural"
    };
    return voiceMap[presenter_id] || "en-US-JennyNeural";
}

// ✅ AWS S3 Upload Function
async function uploadToS3(videoUrl, filename, pathComponents) {
    try {
        console.log("☁️ Uploading to AWS S3...");
        console.log("📁 Bucket:", S3_BUCKET_NAME);
        console.log("📁 Region:", process.env.AWS_REGION || 'ap-south-1');

        const { standard, subject, lesson, topic } = pathComponents;

        // Generate dynamic S3 path - S3 will AUTO-CREATE all folders!
        const folderPath = generateS3Path(standard, subject, lesson, topic);

        // Add timestamp to filename to ensure uniqueness
        const timestamp = Date.now();
        const uniqueFilename = `${timestamp}_${filename}`;
        const key = `${folderPath}${uniqueFilename}`;

        console.log("📁 S3 Key (folders will be auto-created):", key);
        console.log("📍 Full S3 Path will be:", `s3://${S3_BUCKET_NAME}/${key}`);

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

        // Upload to S3 bucket - S3 will AUTO-CREATE all folders in the path!
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: response.data,
            ContentType: 'video/mp4',
            Metadata: {
                'source': 'd-id-ai-video',
                'uploaded-at': new Date().toISOString(),
                'original-url': videoUrl,
                'standard': standard || 'none',
                'subject': subject || 'none',
                'lesson': lesson || 'none',
                'topic': topic || 'none'
            }
        });

        const result = await s3Client.send(command);
        console.log("✅ Upload to S3 successful!");
        console.log("📁 ETag:", result.ETag);
        console.log("📁 HTTP Status:", result.$metadata?.httpStatusCode);

        // Generate S3 public URL
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
        console.log("🔗 S3 Public URL:", s3Url);

        // Return full path info
        const pathInfo = {
            fullPath: key,
            bucket: S3_BUCKET_NAME,
            baseFolder: S3_BASE_FOLDER,
            standard: sanitizeForS3Path(standard),
            subject: sanitizeForS3Path(subject),
            lesson: sanitizeForS3Path(lesson),
            topic: sanitizeForS3Path(topic),
            filename: uniqueFilename,
            timestamp: timestamp,
            consoleUrl: `https://s3.console.aws.amazon.com/s3/buckets/${S3_BUCKET_NAME}/prefix=${folderPath}`
        };

        return { s3Url, pathInfo };

    } catch (error) {
        console.error("❌ Upload to S3 failed with details:");
        console.error("   Error Message:", error.message);
        console.error("   Error Code:", error.code);
        console.error("   Error Name:", error.name);

        if (error.name === 'CredentialsProviderError') {
            throw new Error("S3 upload failed: IAM Role not properly configured. Check EC2 instance role.");
        } else if (error.name === 'AccessDenied') {
            throw new Error("S3 upload failed: Permission denied. Check IAM Role S3 permissions.");
        } else {
            throw new Error(`S3 upload failed: ${error.message}`);
        }
    }
}

// ✅ Test endpoint to verify S3 path creation
app.get("/api/test-s3-path-creation", async (req, res) => {
    try {
        console.log("🧪 Testing S3 automatic folder creation...");

        const testData = {
            standard: "10",
            subject: "Mathematics",
            lesson: "Algebra",
            topic: "Quadratic_Equations"
        };

        const testFilename = `test_${Date.now()}.txt`;
        const testContent = `This file tests S3 automatic folder creation.
Path: subtopics/aivideospath/standard_${testData.standard}/${testData.subject}/${testData.lesson}/${testData.topic}/
Time: ${new Date().toISOString()}`;

        // Generate the path
        const folderPath = generateS3Path(
            testData.standard,
            testData.subject,
            testData.lesson,
            testData.topic
        );

        const key = `${folderPath}${testFilename}`;

        console.log("📁 Testing with key:", key);

        // Upload test file - S3 will AUTO-CREATE folders!
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: testContent,
            ContentType: 'text/plain',
            Metadata: {
                'test': 'true',
                'timestamp': Date.now().toString()
            }
        });

        const result = await s3Client.send(command);

        const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;

        console.log("✅ Test file uploaded successfully!");
        console.log("📍 S3 Console URL:", `https://s3.console.aws.amazon.com/s3/buckets/${S3_BUCKET_NAME}/prefix=${folderPath}`);

        res.json({
            success: true,
            message: "✅ S3 automatic folder creation successful!",
            details: {
                bucket: S3_BUCKET_NAME,
                path: folderPath,
                fullKey: key,
                s3Url: s3Url,
                consoleUrl: `https://s3.console.aws.amazon.com/s3/buckets/${S3_BUCKET_NAME}/prefix=${folderPath}`,
                note: "Folders were automatically created by S3 - no manual creation needed!"
            }
        });

    } catch (error) {
        console.error("❌ Test failed:", error);
        res.status(500).json({
            success: false,
            error: error.message,
            note: "Check IAM role permissions for s3:PutObject"
        });
    }
});

// ✅ Endpoint to check bucket and path
app.get("/api/check-s3-bucket", async (req, res) => {
    try {
        const bucketInfo = {
            bucket: S3_BUCKET_NAME,
            region: process.env.AWS_REGION || 'ap-south-1',
            baseFolder: S3_BASE_FOLDER,
            usingIAMRole: true,
            note: "S3 automatically creates folders when you upload with a path",
            example: {
                path: `${S3_BASE_FOLDER}/standard_10/Mathematics/Algebra/Quadratic_Equations/`,
                howItWorks: "Upload a file with this path and S3 creates all folders automatically"
            }
        };

        res.json({
            success: true,
            bucketInfo
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ ENHANCED: saveVideoToDatabase with custom description support
async function saveVideoToDatabase(s3Url, subtopicId, dbname, subjectName, customDescription = null) {
    console.log("💾 ENHANCED SAVE TO DATABASE: Starting...");
    console.log("📋 Parameters:", { subtopicId, dbname, subjectName, s3Url, customDescription });

    try {
        const dbConn = getDB(dbname);
        const collection = dbConn.collection(subjectName);

        if (!subjectName || subjectName.trim() === "") {
            throw new Error("subjectName is required");
        }

        // ✅ FIXED: Build consistent update data
        const baseUpdateData = {
            aiVideoUrl: s3Url,
            updatedAt: new Date(),
            videoStorage: "aws_s3",
            s3Path: s3Url.split('.com/')[1]
        };

        // ✅ FIXED: Add custom description fields
        if (customDescription && customDescription.trim() !== "") {
            baseUpdateData.customDescription = customDescription;
            baseUpdateData.description = customDescription; // Update main description
            baseUpdateData.updatedDescriptionAt = new Date();
            console.log("✅ Custom description will be saved:", customDescription.substring(0, 100) + "...");
        }

        // ✅ STEP 1: Try direct MongoDB updates first (more reliable)
        console.log("🔄 Step 1: Direct MongoDB updates...");

        // Strategy 1: Try with ObjectId if valid
        if (ObjectId.isValid(subtopicId)) {
            const objectId = new ObjectId(subtopicId);

            // 1.1: Update as main document with ObjectId
            const result1 = await collection.updateOne(
                { "_id": objectId },
                { $set: baseUpdateData }
            );

            if (result1.modifiedCount > 0) {
                console.log("✅ Updated as main document with ObjectId");
                return {
                    success: true,
                    message: "Video URL and custom description saved as main document",
                    collection: subjectName,
                    updateMethod: "main_document_objectid",
                    matchedCount: result1.matchedCount,
                    modifiedCount: result1.modifiedCount,
                    customDescriptionSaved: !!customDescription
                };
            }

            // 1.2: Update in nested arrays with ObjectId
            const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

            for (const field of arrayFields) {
                // Build dynamic update for nested arrays
                const nestedUpdate = {};
                for (const key in baseUpdateData) {
                    nestedUpdate[`${field}.$.${key}`] = baseUpdateData[key];
                }

                const result = await collection.updateOne(
                    { [`${field}._id`]: objectId },
                    { $set: nestedUpdate }
                );

                if (result.modifiedCount > 0) {
                    console.log(`✅ Updated in nested ${field} array with ObjectId`);
                    return {
                        success: true,
                        message: `Video URL and custom description saved in ${field} array`,
                        collection: subjectName,
                        updateMethod: `nested_${field}_objectid`,
                        matchedCount: result.matchedCount,
                        modifiedCount: result.modifiedCount,
                        customDescriptionSaved: !!customDescription
                    };
                }
            }

            // ✅ NEW: Try deep nested update with ObjectId
            console.log("🔄 Trying deep nested ObjectId update...");
            const allDocs = await collection.find({}).toArray();

            for (const document of allDocs) {
                const deepUpdateResult = await updateNestedArrayWithObjectId(
                    collection,
                    document,
                    objectId,
                    s3Url,
                    customDescription
                );

                if (deepUpdateResult.success) {
                    console.log("✅ Deep nested ObjectId update successful");
                    return {
                        ...deepUpdateResult,
                        customDescriptionSaved: !!customDescription
                    };
                }
            }
        }

        // ✅ STEP 2: Try with string ID
        console.log("🔄 Step 2: Trying string ID updates...");

        // 2.1: Update as main document with string ID
        const result2 = await collection.updateOne(
            { "_id": subtopicId },
            { $set: baseUpdateData }
        );

        if (result2.modifiedCount > 0) {
            console.log("✅ Updated as main document with string ID");
            return {
                success: true,
                message: "Video URL and custom description saved as main document (string ID)",
                collection: subjectName,
                updateMethod: "main_document_string",
                matchedCount: result2.matchedCount,
                modifiedCount: result2.modifiedCount,
                customDescriptionSaved: !!customDescription
            };
        }

        // 2.2: Update in nested arrays with string ID
        const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

        for (const field of arrayFields) {
            // Build dynamic update for nested arrays
            const nestedUpdate = {};
            for (const key in baseUpdateData) {
                nestedUpdate[`${field}.$.${key}`] = baseUpdateData[key];
            }

            // Try with _id field
            const result = await collection.updateOne(
                { [`${field}._id`]: subtopicId },
                { $set: nestedUpdate }
            );

            if (result.modifiedCount > 0) {
                console.log(`✅ Updated in nested ${field}._id array with string ID`);
                return {
                    success: true,
                    message: `Video URL and custom description saved in ${field}._id array`,
                    collection: subjectName,
                    updateMethod: `nested_${field}_string_id`,
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    customDescriptionSaved: !!customDescription
                };
            }

            // Try with id field
            const result2 = await collection.updateOne(
                { [`${field}.id`]: subtopicId },
                { $set: nestedUpdate }
            );

            if (result2.modifiedCount > 0) {
                console.log(`✅ Updated in nested ${field}.id array with string ID`);
                return {
                    success: true,
                    message: `Video URL and custom description saved in ${field}.id array`,
                    collection: subjectName,
                    updateMethod: `nested_${field}_string_field`,
                    matchedCount: result2.matchedCount,
                    modifiedCount: result2.modifiedCount,
                    customDescriptionSaved: !!customDescription
                };
            }
        }

        // ✅ NEW: Try deep nested update with String ID
        console.log("🔄 Trying deep nested String ID update...");
        const allDocs2 = await collection.find({}).toArray();

        for (const document of allDocs2) {
            const deepUpdateResult = await updateNestedArrayWithStringId(
                collection,
                document,
                subtopicId,
                s3Url,
                customDescription
            );

            if (deepUpdateResult.success) {
                console.log("✅ Deep nested String ID update successful");
                return {
                    ...deepUpdateResult,
                    customDescriptionSaved: !!customDescription
                };
            }
        }

        // ✅ STEP 3: Recursive search and update
        console.log("🔄 Step 3: Trying recursive search and update...");
        const allDocuments = await collection.find({}).toArray();

        for (const document of allDocuments) {
            const updated = await updateNestedStructureRecursive(
                collection,
                document,
                subtopicId,
                baseUpdateData
            );

            if (updated.success) {
                return {
                    ...updated,
                    customDescriptionSaved: !!customDescription
                };
            }
        }

        // ✅ STEP 4: Try multi-level nested array update
        console.log("🔄 Step 4: Trying multi-level nested array update...");
        const nestedFields = ['units', 'subtopics', 'children'];

        for (const field of nestedFields) {
            const multiLevelResult = await updateMultiLevelNestedArray(
                collection,
                field,
                subtopicId,
                s3Url
            );

            if (multiLevelResult.success) {
                console.log(`✅ Multi-level update in ${field} successful`);
                return {
                    ...multiLevelResult,
                    customDescriptionSaved: !!customDescription
                };
            }
        }

        // If nothing worked
        console.log("❌ All update strategies failed");
        return {
            success: false,
            message: "Subtopic not found in database",
            collection: subjectName,
            updateMethod: "not_found",
            customDescriptionSaved: false,
            debug: {
                subtopicId: subtopicId,
                isObjectId: ObjectId.isValid(subtopicId),
                customDescriptionProvided: !!customDescription,
                customDescriptionLength: customDescription?.length || 0
            }
        };

    } catch (error) {
        console.error("❌ Database save error:", error);
        return {
            success: false,
            message: "Database save failed: " + error.message,
            customDescriptionSaved: false
        };
    }
}

async function updateNestedStructureRecursive(collection, document, targetId, updateData) {
    try {
        const docId = document._id;
        const path = findPathInNested(document, targetId);

        if (path) {
            // Build the update query dynamically
            const updateQuery = {};
            for (const key in updateData) {
                updateQuery[`${path}.${key}`] = updateData[key];
            }

            const result = await collection.updateOne(
                { "_id": docId },
                { $set: updateQuery }
            );

            if (result.modifiedCount > 0) {
                return {
                    success: true,
                    message: `Updated at path: ${path}`,
                    updateMethod: "recursive_update",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    customDescriptionSaved: updateData.customDescription !== undefined
                };
            }
        }

        return { success: false };
    } catch (error) {
        console.error("❌ Recursive update error:", error);
        return { success: false };
    }
}

// ✅ UPDATED: Helper function to update deeply nested arrays with ObjectId
async function updateNestedArrayWithObjectId(collection, document, objectId, s3Url, customDescription = null) {
    try {
        const documentId = document._id;

        // Function to search and build update path
        const findPath = (obj, targetId, path = '') => {
            if (!obj || typeof obj !== 'object') return null;

            // Check all array fields
            const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

            for (const field of arrayFields) {
                if (Array.isArray(obj[field])) {
                    for (let i = 0; i < obj[field].length; i++) {
                        const item = obj[field][i];
                        const itemId = item._id || item.id;

                        // Compare ObjectIds
                        if (itemId && itemId.toString() === targetId.toString()) {
                            return `${field}.${i}`;
                        }

                        // Search deeper
                        const deeperPath = findPath(item, targetId, `${field}.${i}`);
                        if (deeperPath) {
                            return `${field}.${i}.${deeperPath}`;
                        }
                    }
                }
            }

            return null;
        };

        const path = findPath(document, objectId);

        if (path) {
            // Build the update query
            const updateQuery = {};
            updateQuery[`${path}.aiVideoUrl`] = s3Url;
            updateQuery[`${path}.updatedAt`] = new Date();
            updateQuery[`${path}.videoStorage`] = "aws_s3";
            updateQuery[`${path}.s3Path`] = s3Url.split('.com/')[1];

            // Add custom description
            if (customDescription) {
                updateQuery[`${path}.customDescription`] = customDescription;
                updateQuery[`${path}.description`] = customDescription;
                updateQuery[`${path}.updatedDescriptionAt`] = new Date();
            }

            const result = await collection.updateOne(
                { "_id": documentId },
                { $set: updateQuery }
            );

            if (result.modifiedCount > 0) {
                return {
                    success: true,
                    message: `Video URL and description saved at path: ${path}`,
                    updateMethod: "deep_nested_objectid",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    customDescriptionSaved: !!customDescription
                };
            }
        }

        return { success: false };

    } catch (error) {
        console.error("❌ Nested array update error:", error);
        return { success: false };
    }
}

// ✅ NEW: Helper function to update deeply nested arrays with String ID
async function updateNestedArrayWithStringId(collection, document, stringId, s3Url, customDescription = null) {
    try {
        const documentId = document._id;

        // Function to search and build update path
        const findPath = (obj, targetId, path = '') => {
            if (!obj || typeof obj !== 'object') return null;

            // Check all array fields
            const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

            for (const field of arrayFields) {
                if (Array.isArray(obj[field])) {
                    for (let i = 0; i < obj[field].length; i++) {
                        const item = obj[field][i];
                        const itemId = item._id || item.id;

                        // Compare string IDs
                        if (itemId && itemId.toString() === targetId) {
                            return `${field}.${i}`;
                        }

                        // Search deeper
                        const deeperPath = findPath(item, targetId, `${field}.${i}`);
                        if (deeperPath) {
                            return `${field}.${i}.${deeperPath}`;
                        }
                    }
                }
            }

            return null;
        };

        const path = findPath(document, stringId);

        if (path) {
            // Build the update query
            const updateQuery = {};
            updateQuery[`${path}.aiVideoUrl`] = s3Url;
            updateQuery[`${path}.updatedAt`] = new Date();
            updateQuery[`${path}.videoStorage`] = "aws_s3";
            updateQuery[`${path}.s3Path`] = s3Url.split('.com/')[1];

            if (customDescription && customDescription.trim() !== "") {
                updateQuery[`${path}.customDescription`] = customDescription;
                updateQuery[`${path}.description`] = customDescription;
                updateQuery[`${path}.updatedDescriptionAt`] = new Date();
                console.log(`✅ Adding custom description to update at path: ${path}`);
            }

            const result = await collection.updateOne(
                { "_id": documentId },
                { $set: updateQuery }
            );

            if (result.modifiedCount > 0) {
                return {
                    success: true,
                    message: `Video URL ${customDescription ? 'and description' : ''} saved at path: ${path}`,
                    updateMethod: "deep_nested_stringid",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    customDescriptionSaved: !!customDescription
                };
            }
        }

        return { success: false };

    } catch (error) {
        console.error("❌ Nested array update error:", error);
        return { success: false };
    }
}

// ✅ NEW: Multi-level nested array update using aggregation
async function updateMultiLevelNestedArray(collection, fieldName, subtopicId, s3Url, customDescription = null) {
    try {
        console.log(`🔍 Searching multi-level nested in ${fieldName} for: ${subtopicId}`);

        // Use aggregation to find the document
        const pipeline = [
            {
                $match: {
                    $or: [
                        { [`${fieldName}._id`]: subtopicId },
                        { [`${fieldName}.id`]: subtopicId },
                        { [`${fieldName}.${fieldName}._id`]: subtopicId },
                        { [`${fieldName}.${fieldName}.id`]: subtopicId }
                    ]
                }
            }
        ];

        const docs = await collection.aggregate(pipeline).toArray();

        if (docs.length > 0) {
            const doc = docs[0];
            const docId = doc._id;

            // Try to build the update path
            let updatePath = null;

            // Search for the item
            const searchItem = (items, targetId, path = fieldName) => {
                if (!Array.isArray(items)) return null;

                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    const itemId = item._id || item.id;

                    if (itemId && itemId.toString() === targetId) {
                        return `${path}.${i}`;
                    }

                    // Check nested arrays
                    if (item[fieldName] && Array.isArray(item[fieldName])) {
                        const nestedPath = searchItem(item[fieldName], targetId, `${path}.${i}.${fieldName}`);
                        if (nestedPath) return nestedPath;
                    }
                }

                return null;
            };

            if (doc[fieldName] && Array.isArray(doc[fieldName])) {
                updatePath = searchItem(doc[fieldName], subtopicId);
            }

            if (updatePath) {
                // Build the update query
                const updateQuery = {};
                updateQuery[`${updatePath}.aiVideoUrl`] = s3Url;
                updateQuery[`${updatePath}.updatedAt`] = new Date();
                updateQuery[`${updatePath}.videoStorage`] = "aws_s3";
                updateQuery[`${updatePath}.s3Path`] = s3Url.split('.com/')[1];

                if (customDescription && customDescription.trim() !== "") {
                    updateQuery[`${updatePath}.customDescription`] = customDescription;
                    updateQuery[`${updatePath}.description`] = customDescription;
                    updateQuery[`${updatePath}.updatedDescriptionAt`] = new Date();
                    console.log(`✅ Adding custom description to multi-level update at path: ${updatePath}`);
                }

                const result = await collection.updateOne(
                    { "_id": docId },
                    { $set: updateQuery }
                );

                if (result.modifiedCount > 0) {
                    return {
                        success: true,
                        message: `Video URL ${customDescription ? 'and description' : ''} saved at multi-level path: ${updatePath}`,
                        updateMethod: "multi_level_nested",
                        matchedCount: result.matchedCount,
                        modifiedCount: result.modifiedCount,
                        customDescriptionSaved: !!customDescription
                    };
                }
            }
        }

        return { success: false };

    } catch (error) {
        console.error("❌ Multi-level update error:", error);
        return { success: false };
    }
}

// ✅ SIMPLIFIED: Create folder structure in S3
app.post("/api/create-s3-folder", async (req, res) => {
    try {
        const { folderPath, bucket } = req.body;

        if (!folderPath) {
            return res.status(400).json({
                success: false,
                error: "Missing folderPath"
            });
        }

        console.log("📁 Creating folder structure:", folderPath);

        // Parse the folder path
        let targetBucket = bucket || S3_BUCKET_NAME;
        let targetPrefix = folderPath;

        if (folderPath.startsWith('s3://')) {
            const pathWithoutPrefix = folderPath.replace('s3://', '');
            const firstSlashIndex = pathWithoutPrefix.indexOf('/');
            targetBucket = pathWithoutPrefix.substring(0, firstSlashIndex);
            targetPrefix = pathWithoutPrefix.substring(firstSlashIndex + 1);
        }

        // Ensure the path ends with a slash
        if (!targetPrefix.endsWith('/')) {
            targetPrefix = targetPrefix + '/';
        }

        // Create a folder marker file
        const folderMarkerKey = targetPrefix + 'folder_placeholder.txt';

        await s3Client.send(new PutObjectCommand({
            Bucket: targetBucket,
            Key: folderMarkerKey,
            Body: `Folder created on ${new Date().toISOString()}`,
            ContentType: 'text/plain'
        }));

        console.log("✅ Folder structure created:", targetPrefix);

        res.json({
            success: true,
            message: "Folder structure created successfully",
            directory: targetPrefix,
            bucket: targetBucket,
            consoleUrl: `https://s3.console.aws.amazon.com/s3/buckets/${targetBucket}/prefix=${targetPrefix}`
        });

    } catch (error) {
        console.error("❌ Error creating folder:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ CORRECTED: Copies S3 file and updates the nested aiVideoUrl in the database
app.post("/api/copy-s3-file", async (req, res) => {
    try {
        const {
            sourceUrl,
            destinationPath,
            dbname,
            subjectName,
            subtopicId, // This is the ID of the unit inside the 'units' array (e.g., '691c14f00fda8802535b4f42')
            customDescription
        } = req.body;

        console.log("🔄 Starting S3 file COPY process...");
        console.log("📁 Source URL:", sourceUrl);
        console.log("📁 Destination Path:", destinationPath);
        console.log("📌 Subtopic ID (target for update):", subtopicId);
        console.log("📌 Subject:", subjectName);

        // --- Input Validation ---
        if (!sourceUrl || !destinationPath || !subtopicId || !subjectName) {
            return res.status(400).json({ success: false, error: "Missing required parameters" });
        }

        // --- 1. Parse and Execute S3 Copy ---
        const urlMatch = sourceUrl.match(/https:\/\/(.+?)\.s3\.(.+?)\.amazonaws\.com\/(.+)/);
        if (!urlMatch) {
            return res.status(400).json({ success: false, error: "Invalid S3 URL format" });
        }
        const sourceBucket = urlMatch[1];
        const region = urlMatch[2];
        const sourceKey = urlMatch[3];

        let targetKey = destinationPath;
        if (destinationPath.startsWith('s3://')) {
            const pathParts = destinationPath.replace('s3://', '').split('/');
            pathParts.shift(); // Remove bucket name
            targetKey = pathParts.join('/');
        }

        console.log("📋 Copying file...");
        await s3Client.send(new CopyObjectCommand({
            Bucket: sourceBucket,
            CopySource: encodeURIComponent(`${sourceBucket}/${sourceKey}`),
            Key: targetKey,
            MetadataDirective: 'COPY'
        }));
        console.log("✅ File copied successfully");

        const newUrl = `https://${sourceBucket}.s3.${region}.amazonaws.com/${targetKey}`;

        // --- 2. Update the Nested aiVideoUrl in MongoDB ---
        console.log(`💾 Updating database for Subtopic ID: ${subtopicId}`);

        const dbConn = getDB(dbname);
        const collection = dbConn.collection(subjectName);

        // Convert the subtopicId to an ObjectId. This is CRITICAL for the query to work.
        const subtopicObjectId = new ObjectId(subtopicId);

        // --- The Correct MongoDB Update Query ---
        // This query finds the document that contains a 'units' array
        // with an element whose '_id' field matches subtopicObjectId.
        // The '$' positional operator then updates the 'aiVideoUrl' of that specific array element.
        const updateResult = await collection.updateOne(
            { "units._id": subtopicObjectId },
            {
                $set: {
                    "units.$.aiVideoUrl": newUrl,
                    "units.$.updatedAt": new Date()
                }
            }
        );

        console.log(`📊 Update Result - Matched: ${updateResult.matchedCount}, Modified: ${updateResult.modifiedCount}`);

        // --- 3. Prepare and Send Response ---
        const databaseUpdated = updateResult.modifiedCount > 0;

        if (!databaseUpdated) {
            console.warn(`⚠️ Warning: Database update affected 0 documents. Check if subtopicId '${subtopicId}' exists in the 'units' array.`);
        }

        res.json({
            success: true,
            message: databaseUpdated
                ? "✅ File copied and database updated successfully!"
                : "⚠️ File copied, but the database record was not found or updated.",
            newUrl: newUrl,
            database_updated: databaseUpdated,
            db_details: {
                matchedCount: updateResult.matchedCount,
                modifiedCount: updateResult.modifiedCount
            }
        });

    } catch (error) {
        console.error("❌ Server Error in /api/copy-s3-file:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ DEBUG endpoint to check parameters
app.post("/api/debug-copy-request", async (req, res) => {
    try {
        console.log("🔍 DEBUG - Received request body:", req.body);

        const {
            oldUrl,
            newFullPath,
            dbname,
            subjectName,
            subtopicId
        } = req.body;

        const missingParams = [];
        if (!oldUrl) missingParams.push('oldUrl');
        if (!newFullPath) missingParams.push('newFullPath');
        if (!dbname) missingParams.push('dbname');
        if (!subjectName) missingParams.push('subjectName');
        if (!subtopicId) missingParams.push('subtopicId');

        if (missingParams.length > 0) {
            return res.status(400).json({
                success: false,
                error: "Missing parameters",
                missing: missingParams,
                received: req.body
            });
        }

        res.json({
            success: true,
            message: "All parameters received",
            received: req.body
        });
    } catch (error) {
        console.error("❌ Debug error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

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
            subjectName,
            // ✅ CRITICAL: Get path components
            standard,
            lessonName,
            topicName,
            // ✅ ADD LOGO SIZE PARAMETER
            logoSize = "small"  // Default to small
        } = req.body;

        console.log("🎬 GENERATE VIDEO: Starting video generation for:", subtopic);
        console.log("📋 Path Components:", { standard, subjectName, lessonName, topicName });
        console.log("🖼️ Logo Size:", logoSize);

        // Generate unique job ID
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store initial job status WITH PATH COMPONENTS AND LOGO SIZE
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
            subjectName: subjectName,
            // ✅ CRITICAL: Store path components
            standard: standard || 'no_standard',
            lessonName: lessonName || subtopic,
            topicName: topicName || subtopic,
            // ✅ STORE LOGO SIZE
            logoSize: logoSize
        });

        // ✅ IMMEDIATE RESPONSE
        res.json({
            success: true,
            status: "processing",
            message: "AI video generation started",
            job_id: jobId,
            subtopic: subtopic,
            logo_size: logoSize,
            note: "Video is being generated. Use /api/job-status/:jobId to check progress.",
            estimated_time: "2-3 minutes",
            check_status: `GET /api/job-status/${jobId}`
        });

        // ✅ PROCESS IN BACKGROUND WITH PATH COMPONENTS AND LOGO SIZE
        processVideoJob(jobId, {
            subtopic,
            description,
            questions,
            presenter_id,
            subtopicId,
            parentId,
            rootId,
            dbname,
            subjectName,
            // ✅ CRITICAL: Pass path components
            standard: standard || 'no_standard',
            lessonName: lessonName || subtopic,
            topicName: topicName || subtopic,
            // ✅ PASS LOGO SIZE
            logoSize: logoSize
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

// ✅ NEW: Upload logo to D-ID endpoint
app.post("/api/upload-logo-to-did", async (req, res) => {
    try {
        // Using multer for file upload handling
        const multer = require('multer');
        const upload = multer({ dest: 'uploads/' });

        // Handle file upload
        upload.single('logo')(req, res, async (err) => {
            if (err) {
                console.error("❌ Multer error:", err);
                return res.status(400).json({
                    success: false,
                    error: "File upload error: " + err.message
                });
            }

            const { top = "0", left = "-120" } = req.body;

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: "No logo file provided"
                });
            }

            console.log("📁 Received logo file:", req.file.originalname);
            console.log("📍 Position:", { top, left });

            try {
                // Upload to D-ID
                const uploadResult = await uploadLogoToDID(req.file.path, top, left);

                // Clean up temporary file
                fs.unlink(req.file.path, (unlinkErr) => {
                    if (unlinkErr) console.warn("⚠️ Failed to delete temp file:", unlinkErr);
                });

                if (uploadResult.success) {
                    res.json({
                        success: true,
                        message: "Logo uploaded successfully to D-ID",
                        data: uploadResult.data,
                        position: { top, left }
                    });
                } else {
                    res.status(uploadResult.status || 500).json({
                        success: false,
                        error: uploadResult.error,
                        message: uploadResult.message
                    });
                }

            } catch (uploadError) {
                // Clean up temporary file
                fs.unlink(req.file.path, (unlinkErr) => {
                    if (unlinkErr) console.warn("⚠️ Failed to delete temp file:", unlinkErr);
                });

                console.error("❌ Upload error:", uploadError);
                res.status(500).json({
                    success: false,
                    error: uploadError.message
                });
            }
        });

    } catch (error) {
        console.error("❌ Logo upload endpoint error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ Get current logo settings
app.get("/api/get-did-logo", async (req, res) => {
    try {
        console.log("🖼️ Fetching current D-ID logo settings...");

        const response = await axios.get(
            "https://api.d-id.com/settings/logo",
            {
                headers: {
                    'Authorization': DID_API_KEY,
                    'Accept': 'application/json'
                },
                timeout: 10000
            }
        );

        console.log("✅ Logo settings retrieved");
        res.json({
            success: true,
            data: response.data
        });

    } catch (error) {
        console.error("❌ Failed to get logo settings:");

        if (error.response) {
            console.error("   Status:", error.response.status);
            console.error("   Data:", error.response.data);

            res.status(error.response.status).json({
                success: false,
                error: error.response.data,
                status: error.response.status
            });
        } else {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
});

// ✅ Delete current logo
app.delete("/api/delete-did-logo", async (req, res) => {
    try {
        console.log("🗑️ Deleting D-ID logo...");

        const response = await axios.delete(
            "https://api.d-id.com/settings/logo",
            {
                headers: {
                    'Authorization': DID_API_KEY,
                    'Accept': 'application/json'
                },
                timeout: 10000
            }
        );

        console.log("✅ Logo deleted successfully");
        res.json({
            success: true,
            message: "Logo deleted successfully",
            data: response.data
        });

    } catch (error) {
        console.error("❌ Failed to delete logo:");

        if (error.response) {
            console.error("   Status:", error.response.status);
            console.error("   Data:", error.response.data);

            res.status(error.response.status).json({
                success: false,
                error: error.response.data,
                status: error.response.status
            });
        } else {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
});

// Create uploads directory on startup
function ensureUploadsDirectory() {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
        console.log("📁 Created uploads directory:", uploadsDir);
    } else {
        console.log("✅ Uploads directory exists:", uploadsDir);
    }
}
// Call it with your other startup functions
ensureUploadsDirectory();

// ✅ FIXED: Added logo size control
async function processVideoJob(jobId, {
    subtopic,
    description,
    questions,
    presenter_id,
    subtopicId,
    parentId,
    rootId,
    dbname,
    subjectName,
    // ✅ RECEIVE PATH COMPONENTS
    standard,
    lessonName,
    topicName,
    // ✅ ADD LOGO SIZE PARAMETER
    logoSize = "small"  // Default to small if not provided
}) {
    const MAX_POLLS = 60;

    try {
        console.log(`🔄 Processing video job ${jobId} for:`, subtopic);
        console.log(`🎭 Selected presenter: ${presenter_id}`);
        console.log(`🖼️ Logo size: ${logoSize}`);
        // ✅ VERIFY PATH COMPONENTS ARE RECEIVED
        console.log(`📁 S3 Path Components Received:`, {
            standard: standard || 'no_standard',
            subject: subjectName,
            lesson: lessonName || subtopic,
            topic: topicName || subtopic
        });

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

        // ✅ D-ID API configuration with logo size control
        let requestPayload;

        const studioWatermark = {
            position: "top-right",
            size: "small"
        };

        // For Rian presenter
        if (presenter_id === "v2_public_Rian_NoHands_WhiteTshirt_Home@fJyZiHrDxU") {
            requestPayload = {
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
                // ✅ ADD LOGO SIZE CONTROL
                logo: {
                    size: logoSize  // Uses "small", "medium", or "large"
                    // NO position - uses API setting [-120, 0]
                },
                config: {
                    result_format: "mp4",
                    width: 1280,
                    height: 720,
                    watermark: studioWatermark,
                    fluency: "high",
                    captions: {
                        enabled: true,
                        language: "en"
                    }
                }
            };
        }
        // For Anita presenter with green screen
        else if (presenter_id === "v2_public_anita_pink_shirt_green_screen@pw9Otj5BPp") {
            requestPayload = {
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
                // ✅ ADD LOGO SIZE CONTROL
                logo: {
                    size: logoSize  // Uses "small", "medium", or "large"
                },
                background: {
                    color: "#d4edda"
                },
                config: {
                    result_format: "mp4",
                    width: 1280,
                    height: 720,
                    watermark: studioWatermark,
                    captions: {
                        enabled: true,
                        language: "en"
                    }
                }
            };
        }
        // For all other presenters (default)
        else {
            requestPayload = {
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
                // ✅ ADD LOGO SIZE CONTROL
                logo: {
                    size: logoSize  // Uses "small", "medium", or "large"
                },
                background: { color: "#a5d6a7" },
                config: {
                    result_format: "mp4",
                    width: 1280,
                    height: 720,
                    watermark: studioWatermark,
                    captions: {
                        enabled: true,
                        language: "en"
                    }
                }
            };
        }

        console.log("📤 D-ID Request Payload:", JSON.stringify(requestPayload, null, 2));

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

                    // ✅ AUTOMATICALLY UPLOAD TO S3 WITH PATH COMPONENTS
                    if (videoUrl && videoUrl.includes('d-id.com')) {
                        console.log("☁️ Starting automatic S3 upload with path components...");

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

                            // ✅ CRITICAL FIX: Prepare path components for S3
                            const pathComponents = {
                                standard: standard || 'no_standard',
                                subject: subjectName,
                                lesson: lessonName || subtopic,
                                topic: topicName || subtopic
                            };

                            console.log("📁 S3 Path Components:", pathComponents);
                            console.log("📍 Full S3 Path will be:",
                                `subtopics/aivideospath/${pathComponents.standard}/${pathComponents.subject}/${pathComponents.lesson}/${pathComponents.topic}/${filename}`);

                            // ✅ CRITICAL FIX: Pass path components to uploadToS3
                            const uploadResult = await uploadToS3(videoUrl, filename, pathComponents);
                            const s3Url = uploadResult.s3Url;
                            const pathInfo = uploadResult.pathInfo;

                            console.log("✅ S3 Upload successful!");
                            console.log("📁 S3 Console:", pathInfo.consoleUrl);
                            console.log("📍 Full S3 Path:", pathInfo.fullPath);
                            console.log("🔗 S3 URL:", s3Url);

                            // ✅ AUTOMATICALLY SAVE S3 URL TO DATABASE
                            if (s3Url && subtopicId) {
                                console.log("💾 Automatically saving S3 URL to database...");

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                // Save to database
                                const dbSaveResult = await saveVideoToDatabase(s3Url, subtopicId, dbname, subjectName);

                                console.log("📊 Database save result:", dbSaveResult);

                                // ✅ FINAL: Update job status with path info
                                jobStatus.set(jobId, {
                                    status: 'completed',
                                    subtopic: subtopic,
                                    videoUrl: s3Url,
                                    completedAt: new Date(),
                                    questions: questions.length,
                                    presenter: presenter_id,
                                    storedIn: 'aws_s3',
                                    s3PathInfo: pathInfo,
                                    databaseUpdated: dbSaveResult.success,
                                    updateMethod: dbSaveResult.updateMethod,
                                    collection: dbSaveResult.collection,
                                    s3Url: s3Url,
                                    databaseResult: dbSaveResult
                                });

                            } else {
                                console.log("⚠️ No subtopicId provided, cannot save to database");
                                jobStatus.set(jobId, {
                                    status: 'completed',
                                    subtopic: subtopic,
                                    videoUrl: s3Url,
                                    completedAt: new Date(),
                                    questions: questions.length,
                                    presenter: presenter_id,
                                    storedIn: 'aws_s3',
                                    s3PathInfo: pathInfo,
                                    databaseUpdated: false,
                                    note: 'No subtopicId provided'
                                });
                            }
                        } catch (uploadError) {
                            console.error("❌ S3 upload failed:", uploadError);

                            // Update job status with error
                            jobStatus.set(jobId, {
                                status: 'failed',
                                subtopic: subtopic,
                                error: uploadError.message,
                                failedAt: new Date()
                            });
                        }

                    } else {
                        // If video URL is not from D-ID, just use it as is
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

// ✅ WORKING SOLUTION: S3 Upload with Direct MongoDB Save - Updated for custom description
app.post("/api/upload-to-s3-and-save", async (req, res) => {
    try {
        const {
            videoUrl,
            subtopic,
            subtopicId,
            parentId,
            rootId,
            dbname = "professional",
            subjectName,
            customDescription,
            // ✅ CRITICAL: Get path components from request body
            standard,
            lessonName,
            topicName
        } = req.body;

        console.log("💾 SAVE LESSON: Starting S3 upload with dynamic path");
        console.log("📋 Path Components Received:", {
            standard: standard || 'no_standard',
            subject: subjectName,
            lesson: lessonName || subtopic,
            topic: topicName || subtopic,
            subtopicId
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

        // ✅ CRITICAL: Prepare path components for S3
        const pathComponents = {
            standard: standard || 'no_standard',
            subject: subjectName,
            lesson: lessonName || subtopic,
            topic: topicName || subtopic
        };

        // Generate filename
        const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const timestamp = Date.now();
        const filename = `${safeSubtopicName}_${timestamp}.mp4`;

        let s3Url;
        let pathInfo;

        try {
            // ✅ CRITICAL: Pass pathComponents to uploadToS3
            console.log("☁️ Uploading to S3 with path components:", pathComponents);

            const uploadResult = await uploadToS3(videoUrl, filename, pathComponents);
            s3Url = uploadResult.s3Url;
            pathInfo = uploadResult.pathInfo;

            console.log("✅ S3 Upload successful!");
            console.log("📁 Full S3 Path:", pathInfo.fullPath);
            console.log("📍 S3 Console URL:", pathInfo.consoleUrl);
            console.log("🔗 S3 Public URL:", s3Url);

        } catch (uploadError) {
            console.error("❌ S3 upload failed:", uploadError);
            return res.status(500).json({
                success: false,
                error: "S3 upload failed: " + uploadError.message,
                received_path_components: pathComponents
            });
        }

        // Step 2: Try Spring Boot first (optional)
        let springBootSuccess = false;
        let springBootResponse = null;

        try {
            console.log("🔄 Trying Spring Boot API...");
            const springBootPayload = {
                subtopicId: subtopicId,
                aiVideoUrl: s3Url,
                dbname: dbname,
                subjectName: subjectName,
                parentId: parentId,
                rootId: rootId,
                s3PathInfo: pathInfo
            };

            if (customDescription) {
                springBootPayload.customDescription = customDescription;
            }

            springBootResponse = await axios.put(
                `${config.springBootUrl}/updateSubtopicVideo`,
                springBootPayload,
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 15000
                }
            );
            springBootSuccess = true;
            console.log("✅ Spring Boot success:", springBootResponse.data);

        } catch (springBootError) {
            console.log("⚠️ Spring Boot failed, using direct MongoDB update");
        }

        // Step 3: DIRECT MONGODB UPDATE with path info
        console.log("💾 DIRECT MongoDB Update with path info...");

        let mongoSaveResult = null;

        try {
            mongoSaveResult = await saveVideoToDatabase(
                s3Url,
                subtopicId,
                dbname,
                subjectName,
                customDescription
            );
            console.log("📊 MongoDB save result:", mongoSaveResult);
        } catch (mongoError) {
            console.error("❌ MongoDB direct update error:", mongoError.message);
            mongoSaveResult = {
                success: false,
                message: mongoError.message,
                customDescriptionSaved: false
            };
        }

        // Step 4: Return response with path info
        const dbUpdated = springBootSuccess || (mongoSaveResult && mongoSaveResult.success);
        const descriptionSaved = springBootSuccess || (mongoSaveResult && mongoSaveResult.customDescriptionSaved);

        res.json({
            success: true,
            message: dbUpdated ?
                "✅ Video uploaded to S3 and saved to database" :
                "⚠️ Video uploaded to S3 but database save failed",
            s3_url: s3Url,
            s3_path_info: pathInfo,
            s3_console_url: pathInfo.consoleUrl,
            stored_in: "aws_s3",
            database_updated: dbUpdated,
            custom_description_saved: descriptionSaved,
            update_method: springBootSuccess ? "spring_boot" : (mongoSaveResult?.success ? "mongodb_direct" : "failed"),
            // ✅ Return all path components
            standard: pathInfo.standard,
            subject: pathInfo.subject,
            lesson: pathInfo.lesson,
            topic: pathInfo.topic,
            full_s3_path: `s3://${S3_BUCKET_NAME}/${pathInfo.fullPath}`,
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

app.get("/api/getLatestSubtopic/:subtopicId", async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const { dbname = "professional", subjectName } = req.query;

        console.log("🔍 Fetching subtopic:", subtopicId, "from", subjectName);

        if (!subjectName) {
            return res.status(400).json({
                error: "subjectName query parameter is required"
            });
        }

        const dbConn = getDB(dbname);
        const collection = dbConn.collection(subjectName);

        // Search strategies for finding the subtopic
        const searchStrategies = [];

        // Strategy 1: Direct ID matches
        searchStrategies.push({ query: { "_id": subtopicId } });
        searchStrategies.push({ query: { "id": subtopicId } });

        // Strategy 2: Search in nested arrays
        const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];
        for (const field of arrayFields) {
            searchStrategies.push({
                query: { [`${field}._id`]: subtopicId },
                isNested: true,
                field: field
            });
            searchStrategies.push({
                query: { [`${field}.id`]: subtopicId },
                isNested: true,
                field: field
            });
        }

        // Strategy 3: Try ObjectId if valid
        if (ObjectId.isValid(subtopicId)) {
            const objectId = new ObjectId(subtopicId);
            searchStrategies.push({ query: { "_id": objectId } });

            for (const field of arrayFields) {
                searchStrategies.push({
                    query: { [`${field}._id`]: objectId },
                    isNested: true,
                    field: field
                });
            }
        }

        let foundSubtopic = null;
        let foundStrategy = "";

        // Try all search strategies
        for (const strategy of searchStrategies) {
            try {
                const result = await collection.findOne(strategy.query);

                if (result) {
                    console.log(`✅ Found with strategy: ${JSON.stringify(strategy.query)}`);

                    if (strategy.isNested && strategy.field) {
                        // Extract the nested subtopic
                        const nestedArray = result[strategy.field];
                        if (Array.isArray(nestedArray)) {
                            foundSubtopic = nestedArray.find(item =>
                                (item._id && item._id.toString() === subtopicId) ||
                                (item.id && item.id.toString() === subtopicId)
                            );
                            if (foundSubtopic) {
                                foundStrategy = `nested_${strategy.field}`;
                                break;
                            }
                        }
                    } else {
                        // Direct document match
                        foundSubtopic = result;
                        foundStrategy = "direct";
                        break;
                    }
                }
            } catch (error) {
                console.log(`⚠️ Strategy failed:`, error.message);
            }
        }

        if (foundSubtopic) {
            console.log("✅ Subtopic found:", {
                unitName: foundSubtopic.unitName,
                hasCustomDescription: !!foundSubtopic.customDescription,
                hasDescription: !!foundSubtopic.description,
                customDescription: foundSubtopic.customDescription ? "Yes" : "No"
            });

            // Return the subtopic data with all fields
            res.json({
                success: true,
                found: true,
                strategy: foundStrategy,
                ...foundSubtopic,
                _id: foundSubtopic._id ? foundSubtopic._id.toString() : foundSubtopic._id,
                id: foundSubtopic.id || foundSubtopic._id?.toString()
            });
        } else {
            res.status(404).json({
                success: false,
                found: false,
                message: `Subtopic ${subtopicId} not found in collection ${subjectName}`
            });
        }

    } catch (error) {
        console.error("❌ Error fetching subtopic:", error);
        res.status(500).json({
            success: false,
            error: "Failed to fetch subtopic: " + error.message
        });
    }
});

// ✅ NEW: Debug S3 Configuration Endpoint
app.get("/api/debug-s3", async (req, res) => {
    try {
        const s3Info = {
            bucket: S3_BUCKET_NAME,
            region: process.env.AWS_REGION,
            folder: S3_BASE_FOLDER,
            hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
            hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
            example_url: `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${S3_BASE_FOLDER}filename.mp4`
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
            "POST /api/upload-logo-to-did",
            "GET /api/get-did-logo",
            "DELETE /api/delete-did-logo",
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
    console.log(`☁️ AWS S3 Storage Enabled: Videos will be saved to ${S3_BUCKET_NAME}/${S3_BASE_FOLDER}/[standard]/[subject]/[lesson]/[topic]/`);
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
