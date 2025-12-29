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

connectDB();// ✅ NEW: Enhanced recursive search function
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

app.get("/api/get-subtopic/:subtopicId", async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const { dbname = "professional", subjectName } = req.query;

        console.log("📥 Fetching subtopic content for:", subtopicId);

        if (!subtopicId || !subjectName) {
            return res.status(400).json({
                success: false,
                error: "Missing subtopicId or subjectName"
            });
        }

        const dbConn = getDB(dbname);
        const collection = dbConn.collection(subjectName);

        // Enhanced search to find subtopic in any nested structure
        const searchResult = await findSubtopicInDatabase(subtopicId, dbname, subjectName);

        if (!searchResult.found) {
            return res.json({
                success: false,
                message: "Subtopic not found",
                subtopicId: subtopicId,
                collection: subjectName
            });
        }

        // Extract the subtopic content
        let subtopicContent = "";
        let subtopicName = "";

        if (searchResult.isMainDocument) {
            // It's a main document
            subtopicContent = searchResult.document.description ||
                searchResult.document.content ||
                searchResult.document.notes ||
                "";
            subtopicName = searchResult.document.name ||
                searchResult.document.subtopic ||
                searchResult.document.title ||
                "";
        } else {
            // It's nested - find it in the nested structure
            const findContent = (obj, targetId) => {
                if (!obj || typeof obj !== 'object') return null;

                // Check current object
                if ((obj._id && obj._id.toString() === targetId) ||
                    (obj.id && obj.id.toString() === targetId)) {
                    return obj;
                }

                // Check all array fields
                const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

                for (const field of arrayFields) {
                    if (Array.isArray(obj[field])) {
                        for (const item of obj[field]) {
                            const result = findContent(item, targetId);
                            if (result) return result;
                        }
                    }
                }
                return null;
            };

            const foundItem = findContent(searchResult.document, subtopicId);
            if (foundItem) {
                subtopicContent = foundItem.description ||
                    foundItem.content ||
                    foundItem.notes ||
                    foundItem.explanation ||
                    "";
                subtopicName = foundItem.name ||
                    foundItem.subtopic ||
                    foundItem.title ||
                    "";
            }
        }

        res.json({
            success: true,
            subtopicId: subtopicId,
            name: subtopicName,
            content: subtopicContent,
            originalDescription: subtopicContent, // For compatibility
            collection: subjectName,
            location: searchResult.strategy || searchResult.foundPath || "unknown",
            documentType: searchResult.isMainDocument ? "main_document" : "nested_item",
            hasContent: subtopicContent.length > 0,
            contentLength: subtopicContent.length
        });

    } catch (error) {
        console.error("❌ Error fetching subtopic content:", error);
        res.status(500).json({
            success: false,
            error: "Failed to fetch subtopic content: " + error.message
        });
    }
});

// ✅ NEW: Direct test endpoint for specific subtopic
app.get("/api/test-subtopic-fetch/:subtopicId", async (req, res) => {
  try {
    const { subtopicId } = req.params;
    const { dbname = "professional", subjectName } = req.query;

    console.log("🧪 TEST: Direct fetch for subtopic:", subtopicId);

    if (!subtopicId || !subjectName) {
      return res.status(400).json({
        test: "failed",
        error: "Missing subtopicId or subjectName"
      });
    }

    const dbConn = getDB(dbname);
    const collection = dbConn.collection(subjectName);

    // First, check if collection exists
    const collections = await dbConn.listCollections().toArray();
    const collectionExists = collections.some(c => c.name === subjectName);
    
    if (!collectionExists) {
      return res.json({
        test: "failed",
        error: `Collection '${subjectName}' not found in database '${dbname}'`,
        availableCollections: collections.map(c => c.name)
      });
    }

    // Try to find the subtopic using all possible strategies
    let found = false;
    let location = "";
    let subtopicData = null;
    
    // Strategy 1: Try as main document
    const mainDoc = await collection.findOne({ "_id": subtopicId });
    if (mainDoc) {
      found = true;
      location = "main_document";
      subtopicData = mainDoc;
    }
    
    // Strategy 2: Try ObjectId if valid
    if (!found && ObjectId.isValid(subtopicId)) {
      const objectId = new ObjectId(subtopicId);
      const mainDocObjectId = await collection.findOne({ "_id": objectId });
      if (mainDocObjectId) {
        found = true;
        location = "main_document_objectid";
        subtopicData = mainDocObjectId;
      }
    }

    // Strategy 3: Try in nested arrays
    const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];
    
    if (!found) {
      for (const field of arrayFields) {
        // Try with string ID
        const query = { [`${field}._id`]: subtopicId };
        const doc = await collection.findOne(query);
        if (doc) {
          found = true;
          location = `nested_${field}_id`;
          
          // Find the specific subtopic in the array
          const arrayItems = doc[field] || [];
          const foundItem = arrayItems.find(item => 
            item._id === subtopicId || 
            (item._id && item._id.toString() === subtopicId)
          );
          
          if (foundItem) {
            subtopicData = foundItem;
          } else {
            subtopicData = { parentDoc: doc._id, field: field };
          }
          break;
        }
        
        // Try with id field
        const queryIdField = { [`${field}.id`]: subtopicId };
        const docIdField = await collection.findOne(queryIdField);
        if (docIdField) {
          found = true;
          location = `nested_${field}_string_id`;
          
          // Find the specific subtopic in the array
          const arrayItems = docIdField[field] || [];
          const foundItem = arrayItems.find(item => item.id === subtopicId);
          
          if (foundItem) {
            subtopicData = foundItem;
          } else {
            subtopicData = { parentDoc: docIdField._id, field: field };
          }
          break;
        }
      }
    }

    if (found) {
      // Analyze the subtopic data
      const analysis = {
        found: true,
        location: location,
        subtopicId: subtopicId,
        hasDescription: !!subtopicData.description,
        hasContent: !!subtopicData.content,
        hasNotes: !!subtopicData.notes,
        hasExplanation: !!subtopicData.explanation,
        descriptionLength: subtopicData.description ? subtopicData.description.length : 0,
        contentLength: subtopicData.content ? subtopicData.content.length : 0,
        notesLength: subtopicData.notes ? subtopicData.notes.length : 0,
        allKeys: Object.keys(subtopicData).filter(key => !key.startsWith('_')),
        hasName: !!subtopicData.name,
        hasSubtopic: !!subtopicData.subtopic,
        hasTitle: !!subtopicData.title,
        nameValue: subtopicData.name,
        subtopicValue: subtopicData.subtopic,
        titleValue: subtopicData.title
      };

      // Get the actual content
      let actualContent = "";
      let contentField = "";
      
      if (subtopicData.description && subtopicData.description.trim()) {
        actualContent = subtopicData.description;
        contentField = "description";
      } else if (subtopicData.content && subtopicData.content.trim()) {
        actualContent = subtopicData.content;
        contentField = "content";
      } else if (subtopicData.notes && subtopicData.notes.trim()) {
        actualContent = subtopicData.notes;
        contentField = "notes";
      } else if (subtopicData.explanation && subtopicData.explanation.trim()) {
        actualContent = subtopicData.explanation;
        contentField = "explanation";
      }

      res.json({
        test: "success",
        found: true,
        location: location,
        subtopicId: subtopicId,
        analysis: analysis,
        contentField: contentField,
        contentLength: actualContent.length,
        contentPreview: actualContent.substring(0, 200) + (actualContent.length > 200 ? "..." : ""),
        subtopicData: {
          _id: subtopicData._id,
          id: subtopicData.id,
          name: subtopicData.name,
          subtopic: subtopicData.subtopic,
          title: subtopicData.title,
          // Only include non-empty fields
          ...(subtopicData.description && { description: "..." }),
          ...(subtopicData.content && { content: "..." }),
          ...(subtopicData.notes && { notes: "..." }),
          ...(subtopicData.explanation && { explanation: "..." })
        }
      });
    } else {
      // Try a deep search in all documents
      console.log("🔍 Starting deep search in all documents...");
      const allDocs = await collection.find({}).toArray();
      let deepFound = false;
      let deepLocation = "";
      let deepSubtopic = null;

      for (const doc of allDocs) {
        const searchInDoc = (obj, path = '') => {
          if (!obj || typeof obj !== 'object') return null;
          
          // Check current object
          if (obj._id === subtopicId || 
              (obj._id && obj._id.toString() === subtopicId) ||
              obj.id === subtopicId) {
            return { subtopic: obj, path: path || 'root' };
          }
          
          // Check arrays
          for (const field of arrayFields) {
            if (Array.isArray(obj[field])) {
              for (let i = 0; i < obj[field].length; i++) {
                const newPath = path ? `${path}.${field}[${i}]` : `${field}[${i}]`;
                const result = searchInDoc(obj[field][i], newPath);
                if (result) return result;
              }
            }
          }
          return null;
        };
        
        const result = searchInDoc(doc);
        if (result) {
          deepFound = true;
          deepLocation = result.path;
          deepSubtopic = result.subtopic;
          break;
        }
      }

      if (deepFound) {
        res.json({
          test: "success",
          found: true,
          location: `deep_search: ${deepLocation}`,
          subtopicId: subtopicId,
          deepSearch: true,
          subtopicData: deepSubtopic
        });
      } else {
        res.json({
          test: "failed",
          found: false,
          message: `Subtopic ${subtopicId} not found in collection ${subjectName}`,
          totalDocuments: allDocs.length,
          sampleDocumentIds: allDocs.slice(0, 5).map(doc => ({
            _id: doc._id,
            name: doc.name || doc.subtopic || doc.title || "Unnamed",
            hasUnits: !!doc.units,
            hasSubtopics: !!doc.subtopics,
            hasChildren: !!doc.children
          }))
        });
      }
    }

  } catch (error) {
    console.error("❌ Test endpoint error:", error);
    res.status(500).json({
      test: "error",
      error: error.message,
      stack: error.stack
    });
  }
});

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
// function getVoiceForPresenter(presenter_id) {
//     const voiceMap = {
//         "v2_public_anita@Os4oKCBIgZ": "en-IN-NeerjaNeural",
//         "v2_public_lucas@vngv2djh6d": "en-US-GuyNeural",
//         "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r": "en-GB-RyanNeural"
//     };
//     return voiceMap[presenter_id] || "en-US-JennyNeural";
// }

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

// ✅ AWS S3 Upload Function
// ✅ AWS S3 Upload Function (IAM Role Version)
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("☁️ Uploading to AWS S3...");
        console.log("📁 Bucket:", S3_BUCKET_NAME);
        console.log("📁 Region:", process.env.AWS_REGION || 'ap-south-1');
        console.log("📁 Folder:", S3_FOLDER_PATH);
        console.log("📄 Filename:", filename);

        // ✅ REMOVED: No need to check for credentials when using IAM Role
        console.log("ℹ️ Using IAM Role for S3 access");

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

        // ✅ FIXED: S3 Client without hardcoded credentials
        // IAM Role credentials are automatically injected by AWS SDK
        const s3Client = new S3Client({
            region: process.env.AWS_REGION || 'ap-south-1'
            // NO credentials needed - IAM Role handles it
        });

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
        console.error("   Error Code:", error.code);
        console.error("   Error Name:", error.name);

        // Check if it's a credentials error
        if (error.name === 'CredentialsProviderError') {
            throw new Error("S3 upload failed: IAM Role not properly configured. Check EC2 instance role.");
        } else if (error.name === 'AccessDenied') {
            throw new Error("S3 upload failed: Permission denied. Check IAM Role S3 permissions.");
        } else {
            throw new Error(`S3 upload failed: ${error.message}`);
        }
    }
}


// ✅ IMPROVED: saveVideoToDatabase function with better logging
// ✅ UPDATED: Handle ObjectId format subtopic IDs
// ✅ UPDATED: saveVideoToDatabase with improved nested handling
// ✅ ENHANCED: saveVideoToDatabase with better nested array handling
async function saveVideoToDatabase(s3Url, subtopicId, dbname, subjectName) {
    console.log("💾 ENHANCED SAVE TO DATABASE: Starting...");
    console.log("📋 Parameters:", { subtopicId, dbname, subjectName, s3Url });

    try {
        const dbConn = getDB(dbname);
        const collection = dbConn.collection(subjectName);

        if (!subjectName || subjectName.trim() === "") {
            throw new Error("subjectName is required");
        }

        // ✅ FIRST: Try Spring Boot API (best for nested structures)
        console.log("🔄 Step 1: Trying Spring Boot API...");
        try {
            const springBootResponse = await axios.put(
                "https://dafj1druksig9.cloudfront.net/api/updateSubtopicVideoRecursive",
                {
                    subtopicId: subtopicId,
                    aiVideoUrl: s3Url,
                    dbname: dbname,
                    subjectName: subjectName
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 15000
                }
            );

            console.log("✅ Spring Boot Recursive response:", springBootResponse.data);

            if (springBootResponse.data && springBootResponse.data.status === "success") {
                return {
                    success: true,
                    message: "Video URL saved via Spring Boot Recursive (nested support)",
                    collection: subjectName,
                    updateMethod: "spring_boot_recursive",
                    springBootResponse: springBootResponse.data
                };
            }
        } catch (springBootError) {
            console.log("⚠️ Spring Boot Recursive failed:", springBootError.message);
        }

        // ✅ SECOND: Direct MongoDB update with enhanced nested array support
        console.log("🔄 Step 2: Direct MongoDB update for nested structures...");

        // Build the update data
        const updateData = {
            $set: {
                aiVideoUrl: s3Url,
                updatedAt: new Date(),
                videoStorage: "aws_s3",
                s3Path: s3Url.split('.com/')[1]
            }
        };

        // Strategy 1: Try with ObjectId if valid
        if (ObjectId.isValid(subtopicId)) {
            const objectId = new ObjectId(subtopicId);

            // 1.1: Update as main document
            const result1 = await collection.updateOne(
                { "_id": objectId },
                updateData
            );

            if (result1.modifiedCount > 0) {
                return {
                    success: true,
                    message: "Video URL saved as main document with ObjectId",
                    collection: subjectName,
                    updateMethod: "main_document_objectid",
                    matchedCount: result1.matchedCount,
                    modifiedCount: result1.modifiedCount
                };
            }

            // 1.2: Search in deeply nested arrays using recursive approach
            const allDocuments = await collection.find({}).toArray();

            for (const document of allDocuments) {
                // Try to find and update in nested structure
                const updated = await updateNestedArrayWithObjectId(
                    collection,
                    document,
                    objectId,
                    s3Url
                );

                if (updated.success) {
                    return updated;
                }
            }
        }

        // Strategy 2: Try with string ID
        // 2.1: Update as main document with string ID
        const result2 = await collection.updateOne(
            { "_id": subtopicId },
            updateData
        );

        if (result2.modifiedCount > 0) {
            return {
                success: true,
                message: "Video URL saved as main document with string ID",
                collection: subjectName,
                updateMethod: "main_document_string",
                matchedCount: result2.matchedCount,
                modifiedCount: result2.modifiedCount
            };
        }

        // 2.2: Search in deeply nested arrays using recursive approach for string ID
        const allDocuments = await collection.find({}).toArray();

        for (const document of allDocuments) {
            // Try to find and update in nested structure
            const updated = await updateNestedArrayWithStringId(
                collection,
                document,
                subtopicId,
                s3Url
            );

            if (updated.success) {
                return updated;
            }
        }

        // Strategy 3: Try all array fields with dot notation
        const arrayFields = ['units', 'subtopics', 'children', 'topics', 'lessons'];

        for (const field of arrayFields) {
            // Try with _id field
            const result = await collection.updateOne(
                { [`${field}._id`]: subtopicId },
                {
                    $set: {
                        [`${field}.$.aiVideoUrl`]: s3Url,
                        [`${field}.$.updatedAt`]: new Date(),
                        [`${field}.$.videoStorage`]: "aws_s3",
                        [`${field}.$.s3Path`]: s3Url.split('.com/')[1]
                    }
                }
            );

            if (result.modifiedCount > 0) {
                return {
                    success: true,
                    message: `Video URL saved in ${field}._id array`,
                    collection: subjectName,
                    updateMethod: `positional_${field}_id`,
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount
                };
            }

            // Try with id field
            const result2 = await collection.updateOne(
                { [`${field}.id`]: subtopicId },
                {
                    $set: {
                        [`${field}.$.aiVideoUrl`]: s3Url,
                        [`${field}.$.updatedAt`]: new Date(),
                        [`${field}.$.videoStorage`]: "aws_s3",
                        [`${field}.$.s3Path`]: s3Url.split('.com/')[1]
                    }
                }
            );

            if (result2.modifiedCount > 0) {
                return {
                    success: true,
                    message: `Video URL saved in ${field}.id array`,
                    collection: subjectName,
                    updateMethod: `positional_${field}_string_id`,
                    matchedCount: result2.matchedCount,
                    modifiedCount: result2.modifiedCount
                };
            }

            // Try multi-level nested search for this field
            const multiLevelResult = await updateMultiLevelNestedArray(
                collection,
                field,
                subtopicId,
                s3Url
            );

            if (multiLevelResult.success) {
                return multiLevelResult;
            }
        }

        // If nothing worked
        return {
            success: false,
            message: "Subtopic not found in database",
            collection: subjectName,
            updateMethod: "not_found",
            debug: {
                subtopicId: subtopicId,
                isObjectId: ObjectId.isValid(subtopicId)
            }
        };

    } catch (error) {
        console.error("❌ Database save error:", error);
        return {
            success: false,
            message: "Database save failed: " + error.message
        };
    }
}

// ✅ NEW: Helper function to update deeply nested arrays with ObjectId
async function updateNestedArrayWithObjectId(collection, document, objectId, s3Url) {
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

            const result = await collection.updateOne(
                { "_id": documentId },
                { $set: updateQuery }
            );

            if (result.modifiedCount > 0) {
                return {
                    success: true,
                    message: `Video URL saved at path: ${path}`,
                    updateMethod: "deep_nested_objectid",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount
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
async function updateNestedArrayWithStringId(collection, document, stringId, s3Url) {
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

            const result = await collection.updateOne(
                { "_id": documentId },
                { $set: updateQuery }
            );

            if (result.modifiedCount > 0) {
                return {
                    success: true,
                    message: `Video URL saved at path: ${path}`,
                    updateMethod: "deep_nested_stringid",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount
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
async function updateMultiLevelNestedArray(collection, fieldName, subtopicId, s3Url) {
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
                const updateQuery = {};
                updateQuery[`${updatePath}.aiVideoUrl`] = s3Url;
                updateQuery[`${updatePath}.updatedAt`] = new Date();
                updateQuery[`${updatePath}.videoStorage`] = "aws_s3";
                updateQuery[`${updatePath}.s3Path`] = s3Url.split('.com/')[1];

                const result = await collection.updateOne(
                    { "_id": docId },
                    { $set: updateQuery }
                );

                if (result.modifiedCount > 0) {
                    return {
                        success: true,
                        message: `Video URL saved at multi-level path: ${updatePath}`,
                        updateMethod: "multi_level_nested",
                        matchedCount: result.matchedCount,
                        modifiedCount: result.modifiedCount
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

        // Your custom logo URL
        const customLogoUrl = "https://trilokinnovations-test-admin.s3.ap-south-1.amazonaws.com/Logo/ownlogo.jpeg";

        if (presenter_id === "v2_public_Rian_NoHands_WhiteTshirt_Home@fJyZiHrDxU") {
            // Rian specific configuration (Home presenter - no background)
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
                    watermark: {
                        url: customLogoUrl,
                        position: "top-right",
                        size: "small"
                    },
                    fluency: "high",

                    captions: {
                        enabled: true,
                        language: "en"
                    }
                }
            };
        } else if (presenter_id === "v2_public_anita_pink_shirt_green_screen@pw9Otj5BPp") {
            // Anita with green screen - can have background AND logo
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
                    color: "#f0f8ff"
                },
                config: {
                    result_format: "mp4",
                    width: 1280,
                    height: 720,
                    watermark: {
                        url: customLogoUrl,
                        position: "top-right",
                        size: "small"
                    },

                    captions: {
                        enabled: true,
                        language: "en"
                    }
                }
            };
        } else {
            // Default configuration for Lucas and other presenters
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
                background: { color: "#f0f8ff" },
                config: {
                    result_format: "mp4",
                    width: 1280,
                    height: 720,
                    watermark: {
                        url: customLogoUrl,
                        position: "top-right",
                        size: "small"
                    },

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

                    // ✅ AUTOMATICALLY UPLOAD TO S3
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

                                jobStatus.set(jobId, {
                                    ...jobStatus.get(jobId),
                                    progress: 'Saving to database...'
                                });

                                // Use the FIXED saveVideoToDatabase function
                                const dbSaveResult = await saveVideoToDatabase(s3Url, subtopicId, dbname, subjectName);

                                console.log("📊 Database save result:", dbSaveResult);

                                // ✅ FINAL: Update job status
                                jobStatus.set(jobId, {
                                    status: 'completed',
                                    subtopic: subtopic,
                                    videoUrl: s3Url,
                                    completedAt: new Date(),
                                    questions: questions.length,
                                    presenter: presenter_id,
                                    storedIn: 'aws_s3',
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
                                    const dbSaveResult = await saveVideoToDatabase(videoUrl, subtopicId, dbname, subjectName);
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
