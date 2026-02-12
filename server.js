const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001; // ✅ CHANGED TO 3001 TO AVOID EADDRINUSE

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

// ✅ Dynamic voice selection based on presenter gender
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

// ==================== 🟢 HIERARCHY PATH EXTRACTION FUNCTIONS - MOVED HERE 🟢 ====================
// ✅ ENHANCED: Extract full hierarchical path from database - FIXED VERSION
async function extractFullHierarchyPath(subtopicId, dbname, subjectName) {
    try {
        console.log(`🔍 Extracting full hierarchy path for subtopic: ${subtopicId}`);
        
        const dbConn = getDB(dbname);
        const collection = dbConn.collection(subjectName);
        
        // Find the document containing this subtopic
        const searchResult = await findSubtopicInDatabase(subtopicId, dbname, subjectName);
        
        if (!searchResult.found || !searchResult.document) {
            console.log("⚠️ Subtopic not found, cannot extract hierarchy");
            return null;
        }
        
        const document = searchResult.document;
        let pathComponents = [];
        
        // METHOD 1: Get standard/class from document
        let standard = document.standard || document.class || document.grade || document.level;
        if (!standard) {
            // Try to extract from document structure
            if (document.standard_11 || document.standard11) {
                standard = document.standard_11 || document.standard11;
            }
        }
        
        // Format standard properly
        if (standard) {
            standard = standard.toString().trim();
            if (!standard.includes('Standard_') && !standard.includes('Class_')) {
                standard = `Standard_${standard}`;
            }
            pathComponents.push(standard);
        } else {
            // Default if not found
            pathComponents.push('Standard_11');
        }
        
        // METHOD 2: Get subject from collection name or document
        let subject = document.subject || document.subjectName || subjectName;
        if (subject) {
            subject = subject.toString().trim()
                .replace(/\d+/g, '') // Remove numbers
                .replace(/\s+/g, '_'); // Replace spaces with underscores
            pathComponents.push(subject);
        } else {
            pathComponents.push('Physics'); // Default
        }
        
        // METHOD 3: Build lesson/chapter hierarchy path (PARENT folders)
        const pathSegments = await buildNestedPath(collection, subtopicId, searchResult);
        
        if (pathSegments && pathSegments.length > 0) {
            pathComponents = [...pathComponents, ...pathSegments];
        }
        
        // METHOD 4: Add the current subtopic name as FINAL folder
        let subtopicName = null;
        
        // CRITICAL FIX: Get the actual subtopic object's name
        if (searchResult.foundPath) {
            // Navigate to the actual subtopic object
            const subtopicObj = getNestedObject(document, searchResult.foundPath);
            if (subtopicObj) {
                subtopicName = subtopicObj.unitName || subtopicObj.name || subtopicObj.subtopic || subtopicObj.title;
                console.log(`✅ Found subtopic name from nested object: ${subtopicName}`);
            }
        }
        
        // If not found in nested path, try direct fields (for main documents)
        if (!subtopicName) {
            subtopicName = document.unitName || document.name || document.subtopic || document.title;
            console.log(`✅ Found subtopic name from direct fields: ${subtopicName}`);
        }
        
        // If we have the subtopic name, add it as the final folder
        if (subtopicName) {
            // Clean the subtopic name for filesystem
            subtopicName = subtopicName.toString().trim()
                .replace(/[^\w\s-]/g, '') // Remove special characters
                .replace(/\s+/g, '_') // Replace spaces with underscores
                .substring(0, 30); // Limit length
            
            pathComponents.push(subtopicName);
            console.log(`📁 Added subtopic name to path: ${subtopicName}`);
        } else {
            console.log(`⚠️ Could not find subtopic name, using ID as fallback`);
            // Fallback: use the subtopicId as name
            pathComponents.push(`subtopic_${subtopicId.substring(0, 8)}`);
        }
        
        // Join all components
        const fullPath = pathComponents.join('/');
        console.log(`📁 Generated hierarchy path: ${fullPath}`);
        
        return {
            fullPath: fullPath,
            components: pathComponents,
            standard: pathComponents[0],
            subject: pathComponents[1],
            lesson: pathComponents.length > 2 ? pathComponents[2] : null,
            topic: pathComponents.length > 3 ? pathComponents[3] : null,
            subtopic: pathComponents.length > 4 ? pathComponents[4] : null
        };
        
    } catch (error) {
        console.error("❌ Error extracting full hierarchy:", error);
        return null;
    }
}
// ✅ Helper: Build nested path from parent hierarchy - FIXED VERSION
async function buildNestedPath(collection, subtopicId, searchResult) {
    const pathSegments = [];
    
    try {
        const document = searchResult.document;
        const foundPath = searchResult.foundPath;
        
        if (!foundPath) return pathSegments;
        
        console.log(`🔄 Building nested path from: ${foundPath}`);
        
        // Parse the path to get parent hierarchy
        const pathParts = foundPath.split('.');
        let current = document;
        
        // Go through each parent level (except the last one which is the target)
        for (let i = 0; i < pathParts.length - 1; i++) {
            const part = pathParts[i];
            
            if (part.includes('[') && part.includes(']')) {
                // This is an array access
                const arrayName = part.substring(0, part.indexOf('['));
                const index = parseInt(part.substring(part.indexOf('[') + 1, part.indexOf(']')));
                
                if (current[arrayName] && current[arrayName][index]) {
                    const item = current[arrayName][index];
                    
                    // Extract name from this parent level
                    let itemName = item.unitName || item.name || item.chapterName || item.lessonName || item.title;
                    
                    if (itemName) {
                        itemName = itemName.toString().trim()
                            .replace(/[^\w\s-]/g, '')
                            .replace(/\s+/g, '_')
                            .substring(0, 30);
                        pathSegments.push(itemName);
                        console.log(`📁 Added parent level ${i}: ${itemName}`);
                    } else {
                        // FALLBACK: Use index if no name found
                        const fallbackName = `${arrayName}_${index + 1}`;
                        pathSegments.push(fallbackName);
                        console.log(`📁 Added parent level ${i} (fallback): ${fallbackName}`);
                    }
                    
                    current = item;
                }
            }
        }
        
    } catch (error) {
        console.log("⚠️ Error building nested path:", error.message);
    }
    
    return pathSegments;
}

// ✅ Helper: Get nested object by path string
function getNestedObject(obj, path) {
    if (!obj || !path) return null;
    
    const parts = path.split('.');
    let current = obj;
    
    for (const part of parts) {
        if (part.includes('[') && part.includes(']')) {
            const arrayName = part.substring(0, part.indexOf('['));
            const index = parseInt(part.substring(part.indexOf('[') + 1, part.indexOf(']')));
            
            if (current[arrayName] && current[arrayName][index]) {
                current = current[arrayName][index];
            } else {
                return null;
            }
        } else {
            if (current[part]) {
                current = current[part];
            } else {
                return null;
            }
        }
    }
    
    return current;
}

// ==================== 🟢 END OF HIERARCHY FUNCTIONS 🟢 ====================

// ✅ FIXED: Upload to S3 with auto-created hierarchical paths
async function uploadToS3(videoUrl, filename, pathPrefix = '', subtopicId = null, dbname = null, subjectName = null) {
    try {
        console.log("☁️ Uploading to AWS S3...");
        console.log("📁 Bucket:", S3_BUCKET_NAME);
        console.log("📁 Region:", process.env.AWS_REGION || 'ap-south-1');
        console.log("📄 Filename:", filename);

        // ✅ Download video from D-ID
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

        // ✅ CRITICAL: Determine S3 Key with hierarchical path
        let s3Key;
        let hierarchy = null;

        // STRATEGY 1: Use auto-generated hierarchy from database (PREFERRED)
        if (subtopicId && dbname && subjectName) {
            console.log("🔍 Attempting to auto-generate hierarchical path from database...");
            hierarchy = await extractFullHierarchyPath(subtopicId, dbname, subjectName);
            
            if (hierarchy && hierarchy.fullPath) {
                // Create path: subtopics/*aivideospath*/Standard_11/Physics/lesson_name/topic_name/video.mp4
                s3Key = `subtopics/*aivideospath*/${hierarchy.fullPath}/${filename}`;
                console.log(`📁 Auto-generated hierarchical S3 path: ${s3Key}`);
                console.log(`📊 Path components:`, hierarchy.components);
            } else {
                console.log("⚠️ Could not auto-generate hierarchy, falling back to provided path");
            }
        }
        
        // STRATEGY 2: Use provided pathPrefix if valid and not the old ai_videourl path
        if (!s3Key && pathPrefix && 
            pathPrefix.trim() !== '' && 
            pathPrefix.trim() !== 'ai_videourl' && 
            !pathPrefix.includes('ai_videourl/') &&
            pathPrefix.includes('/')) {
            
            const cleanPath = pathPrefix
                .replace(/\/$/, '')
                .replace(/^\/+/, '')
                .replace(/\s+/g, '_');
            
            // Check if this is already in the new format
            if (cleanPath.includes('*aivideospath*/')) {
                s3Key = `subtopics/${cleanPath}/${filename}`;
            } else {
                // Convert to new format
                s3Key = `subtopics/*aivideospath*/${cleanPath}/${filename}`;
            }
            console.log(`📁 Provided path converted to hierarchical: ${s3Key}`);
        }
        
        // STRATEGY 3: Default - ALWAYS use new hierarchical format for new videos
        if (!s3Key) {
            // This is a new video with no hierarchy info - use default Standard_11/Physics
            const timestamp = Date.now();
            const defaultPath = `Standard_11/Physics/New_Lesson_${timestamp}`;
            s3Key = `subtopics/*aivideospath*/${defaultPath}/${filename}`;
            console.log(`📁 Default hierarchical path (new video): ${s3Key}`);
        }

        console.log("📤 Final S3 Key:", s3Key);

        // ✅ S3 Client with IAM Role
        const s3Client = new S3Client({
            region: process.env.AWS_REGION || 'ap-south-1'
        });

        // Upload to S3 bucket
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: s3Key,
            Body: response.data,
            ContentType: 'video/mp4',
            Metadata: {
                'source': 'd-id-ai-video',
                'uploaded-at': new Date().toISOString(),
                'original-url': videoUrl,
                'path-type': 'hierarchical',
                'path-format': 'subtopics/*aivideospath*/standard/subject/lesson/topic',
                'full-hierarchy': hierarchy ? hierarchy.fullPath : 'not-available',
                'preserve-legacy': 'true' // Flag to indicate we're not touching old videos
            }
        });

        const result = await s3Client.send(command);
        console.log("✅ Upload to S3 successful, ETag:", result.ETag);
        console.log("✅ HTTP Status:", result.$metadata?.httpStatusCode);

        // Generate S3 public URL
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${s3Key}`;
        console.log("🔗 S3 Public URL:", s3Url);

        return s3Url;
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

// Helper function for updateNestedStructureRecursive
function findPathInNested(obj, targetId, currentPath = '') {
    if (!obj || typeof obj !== 'object') return null;
    
    if ((obj._id && obj._id.toString() === targetId.toString()) ||
        (obj.id && obj.id.toString() === targetId.toString())) {
        return currentPath || 'root';
    }
    
    const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];
    
    for (const field of arrayFields) {
        if (Array.isArray(obj[field])) {
            for (let i = 0; i < obj[field].length; i++) {
                const newPath = currentPath ? `${currentPath}.${field}[${i}]` : `${field}[${i}]`;
                const result = findPathInNested(obj[field][i], targetId, newPath);
                if (result) return result;
            }
        }
    }
    
    return null;
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
async function processVideoJob(jobId, { subtopic, description, questions, presenter_id, subtopicId, parentId, rootId, dbname, subjectName }) {
    const MAX_POLLS = 60;

    try {
        console.log(`🔄 Processing video job ${jobId} for:`, subtopic);
        console.log(`🎭 Selected presenter: ${presenter_id}`);

        // ✅ DO NOT try to extract hierarchy here - we'll do it in uploadToS3
        // Just pass the subtopicId, dbname, subjectName to uploadToS3
        
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

        // ✅ FIXED: Configuration for all presenters with custom logo
        let requestPayload;

        const studioWatermark = {
            position: "top-right",
            size: "small"
        };

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
        } else if (presenter_id === "v2_public_anita_pink_shirt_green_screen@pw9Otj5BPp") {
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
        } else {
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

                    // ✅ AUTOMATICALLY UPLOAD TO S3 WITH AUTO-GENERATED HIERARCHICAL PATH
                    if (videoUrl && videoUrl.includes('d-id.com')) {
                        console.log("☁️ Starting automatic S3 upload with auto-generated path...");

                        jobStatus.set(jobId, {
                            ...jobStatus.get(jobId),
                            progress: 'Generating hierarchical path & uploading to S3...'
                        });

                        try {
                            // Generate unique filename for S3
                            const timestamp = Date.now();
                            const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
                            const filename = `video_${safeSubtopicName}_${timestamp}.mp4`;

                            console.log("📄 Uploading to S3 with filename:", filename);
                            
                            // ✅ FIXED: Pass subtopicId, dbname, subjectName for auto-path generation
                            // No pathPrefix needed - it will be auto-generated from database
                            const s3Url = await uploadToS3(
                                videoUrl, 
                                filename, 
                                '', // Empty pathPrefix - use auto-generation
                                subtopicId, // Pass subtopicId for hierarchy extraction
                                dbname,     // Pass dbname
                                subjectName // Pass subjectName
                            );
                            
                            console.log("✅ S3 Upload successful with hierarchical path:", s3Url);

                            // ✅ AUTOMATICALLY SAVE S3 URL TO DATABASE
                            if (s3Url && subtopicId) {
                                console.log("💾 Automatically saving S3 URL to database...");

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                const dbSaveResult = await saveVideoToDatabase(s3Url, subtopicId, dbname, subjectName);

                                console.log("📊 Database save result:", dbSaveResult);

                                jobStatus.set(jobId, {
                                    status: 'completed',
                                    subtopic: subtopic,
                                    videoUrl: s3Url,
                                    completedAt: new Date(),
                                    questions: questions.length,
                                    presenter: presenter_id,
                                    storedIn: 'aws_s3',
                                    storageFormat: 'hierarchical',
                                    s3Path: s3Url.split('.com/')[1],
                                    databaseUpdated: dbSaveResult.success,
                                    updateMethod: dbSaveResult.updateMethod,
                                    collection: dbSaveResult.collection,
                                    databaseResult: dbSaveResult
                                });
                            }
                        } catch (uploadError) {
                            console.error("❌ S3 upload failed:", uploadError);
                            
                            // Fallback: Save D-ID URL directly
                            if (subtopicId) {
                                try {
                                    await saveVideoToDatabase(videoUrl, subtopicId, dbname, subjectName);
                                } catch (dbError) {
                                    console.error("❌ Database update also failed:", dbError);
                                }
                            }

                            jobStatus.set(jobId, {
                                status: 'completed',
                                subtopic: subtopic,
                                videoUrl: videoUrl,
                                completedAt: new Date(),
                                questions: questions.length,
                                presenter: presenter_id,
                                storedIn: 'd_id',
                                databaseUpdated: false,
                                error: 'S3 upload failed, using D-ID URL'
                            });
                        }
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

// ✅ FIXED: S3 Upload with Auto-Generated Hierarchical Path
app.post("/api/upload-to-s3-and-save", async (req, res) => {
    try {
        const {
            videoUrl,
            subtopic,
            subtopicId,
            dbname = "professional",
            subjectName,
            customDescription
        } = req.body;

        console.log("💾 SAVE LESSON: Starting S3 upload with auto-generated path");
        console.log("📋 Parameters:", {
            subtopicId: subtopicId,
            dbname: dbname,
            subjectName: subjectName,
            subtopicName: subtopic,
            hasCustomDescription: !!customDescription
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

        // ✅ Step 1: Generate unique filename
        const timestamp = Date.now();
        const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const filename = `video_${safeSubtopicName}_${timestamp}.mp4`;

        // ✅ Step 2: Upload to S3 with auto-generated hierarchical path
        console.log("☁️ Step 1: Uploading to S3 with auto-generated path...");
        
        let s3Url;
        try {
            // ✅ FIXED: Pass subtopicId, dbname, subjectName for auto-path generation
            s3Url = await uploadToS3(
                videoUrl, 
                filename, 
                '', // Empty pathPrefix - use auto-generation
                subtopicId, // Pass subtopicId for hierarchy extraction
                dbname,     // Pass dbname
                subjectName // Pass subjectName
            );
            console.log("✅ S3 Upload successful:", s3Url);
        } catch (uploadError) {
            console.error("❌ S3 upload failed:", uploadError);
            return res.status(500).json({
                success: false,
                error: "S3 upload failed: " + uploadError.message
            });
        }

        // ✅ Step 3: Try Spring Boot first (optional)
        let springBootSuccess = false;
        try {
            console.log("🔄 Trying Spring Boot API...");
            const springBootPayload = {
                subtopicId: subtopicId,
                aiVideoUrl: s3Url,
                dbname: dbname,
                subjectName: subjectName
            };

            if (customDescription) {
                springBootPayload.customDescription = customDescription;
            }

            springBootPayload.s3Path = s3Url.split('.com/')[1];
            springBootPayload.storageFormat = 'hierarchical';

            await axios.put(
                "https://dafj1druksig9.cloudfront.net/api/updateSubtopicVideo",
                springBootPayload,
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 15000
                }
            );
            springBootSuccess = true;
            console.log("✅ Spring Boot success");
        } catch (springBootError) {
            console.log("⚠️ Spring Boot failed, using direct MongoDB update");
        }

        // ✅ Step 4: Direct MongoDB update
        let mongoSaveResult = null;
        try {
            mongoSaveResult = await saveVideoToDatabase(s3Url, subtopicId, dbname, subjectName, customDescription);
            console.log("📊 MongoDB save result:", mongoSaveResult);
        } catch (mongoError) {
            console.error("❌ MongoDB direct update error:", mongoError.message);
        }

        // ✅ Step 5: Extract path components for response
        const s3Path = s3Url.split('.com/')[1];
        const pathParts = s3Path.split('/');
        
        // Find where *aivideospath* is located
        const aivideospathIndex = pathParts.indexOf('*aivideospath*');
        
        let hierarchy = {};
        if (aivideospathIndex !== -1 && pathParts.length > aivideospathIndex + 1) {
            hierarchy = {
                base: pathParts.slice(0, aivideospathIndex + 1).join('/'),
                standard: pathParts[aivideospathIndex + 1] || null,
                subject: pathParts[aivideospathIndex + 2] || null,
                lesson: pathParts[aivideospathIndex + 3] || null,
                topic: pathParts[aivideospathIndex + 4] || null,
                filename: pathParts[pathParts.length - 1]
            };
        }

        // ✅ Step 6: Return response
        res.json({
            success: true,
            message: "Video uploaded to S3 with auto-generated hierarchical path",
            s3_url: s3Url,
            s3_path: s3Path,
            storage_format: "hierarchical",
            legacy_videos_preserved: true, // Important flag to show old videos are untouched
            path_hierarchy: hierarchy,
            database_updated: springBootSuccess || (mongoSaveResult?.success || false),
            custom_description_saved: springBootSuccess || (mongoSaveResult?.customDescriptionSaved || false),
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

// ✅ FIXED: Debug path endpoint showing new hierarchical format
app.get("/api/debug-path", async (req, res) => {
    try {
        const { subtopicId, dbname = "professional", subjectName } = req.query;
        
        let pathInfo = {
            legacy_format: {
                description: "Old videos stored in subtopics/ai_videourl/ - 509 videos preserved, NOT TOUCHED",
                example: `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/subtopics/ai_videourl/old_video_12345.mp4`,
                preserved: true,
                count_estimate: 509
            },
            new_format: {
                description: "New videos stored in subtopics/*aivideospath*/Standard_11/Physics/Lesson_Name/Topic_Name/video.mp4",
                example: `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/subtopics/*aivideospath*/Standard_11/Physics/1_UNITS_AND_MEASUREMENT/1_1_Introduction/video_test_12345.mp4`,
                auto_generated: true
            }
        };

        // If subtopicId is provided, show actual path that would be generated
        if (subtopicId && subjectName) {
            const hierarchy = await extractFullHierarchyPath(subtopicId, dbname, subjectName);
            
            if (hierarchy) {
                const filename = `video_${subtopicId}_${Date.now()}.mp4`;
                const s3Key = `subtopics/*aivideospath*/${hierarchy.fullPath}/${filename}`;
                const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${s3Key}`;
                
                pathInfo.generated_for_subtopic = {
                    subtopicId: subtopicId,
                    hierarchy: hierarchy,
                    s3Key: s3Key,
                    s3Url: s3Url
                };
            }
        }

        res.json({
            success: true,
            path_info: pathInfo,
            bucket: S3_BUCKET_NAME,
            region: process.env.AWS_REGION || 'ap-south-1',
            note: "✅ Legacy videos in subtopics/ai_videourl/ are PRESERVED - no migration occurs",
            note2: "✅ New videos automatically stored in subtopics/*aivideospath*/[standard]/[subject]/[lesson]/[topic]/video.mp4",
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error("❌ Debug path error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "Node.js AI Video Backend with AWS S3 Storage",
        storage: {
            legacy: "subtopics/ai_videourl/ - 509 videos preserved, NOT TOUCHED",
            new: "subtopics/*aivideospath*/[standard]/[subject]/[lesson]/[topic]/ - auto-generated hierarchy"
        },
        endpoints: [
            "POST /generate-and-upload",
            "POST /api/upload-to-s3-and-save",
            "PUT /api/updateSubtopicVideo",
            "PUT /api/updateSubtopicVideoRecursive",
            "GET /api/debug-subtopic/:id",
            "GET /api/debug-s3",
            "GET /api/debug-path",
            "GET /api/job-status/:jobId",
            "GET /api/jobs",
            "GET /health",
            "GET /api/test"
        ],
        version: "hierarchical-path-auto-generation-2025-02-11"
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

// ⬇️ MOVE THE 404 HANDLER TO BE RIGHT HERE - THE VERY LAST ROUTE ⬇️
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
            "GET /api/debug-path",
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
    console.log(`   GET /api/debug-path`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   GET /api/jobs`);
    console.log(`   GET /health`);
    console.log(`   GET /api/test`);
    console.log("🚀 SERVER VERSION: hierarchical-path-auto-generation-2025-02-11");
    console.log(`✅ LEGACY VIDEOS PRESERVED: 509 videos in subtopics/ai_videourl/ - NOT TOUCHED`);
    console.log(`✅ NEW VIDEOS: Auto-stored in subtopics/*aivideospath*/[standard]/[subject]/[lesson]/[topic]/`);
});

//http://localhost:3001/api/debug-path?subtopicId=691c14f00fda8802535b4f42&subjectName=Physics
