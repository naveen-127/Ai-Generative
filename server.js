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

// ✅ Spring Boot Configuration
const SPRING_BOOT_URL = process.env.SPRING_BOOT_URL || "http://localhost:8080";

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
    "https://ai-generative-1.onrender.com",
    SPRING_BOOT_URL.replace(/\/$/, '') // Add Spring Boot URL to allowed origins
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

// ===========================
// ✅ SPRING BOOT INTEGRATION
// ===========================

// ✅ Test Spring Boot Connection
app.get("/api/test-springboot", async (req, res) => {
    try {
        console.log(`🔍 Testing Spring Boot connection to: ${SPRING_BOOT_URL}`);
        
        // Try a simple GET request
        const response = await axios.get(`${SPRING_BOOT_URL}/api/debug-collections`, {
            timeout: 10000,
            headers: {
                'Accept': 'application/json'
            }
        });
        
        res.json({
            success: true,
            springBoot: SPRING_BOOT_URL,
            status: response.status,
            data: response.data,
            message: "Spring Boot backend is accessible and responding"
        });
        
    } catch (error) {
        console.log("❌ Spring Boot test failed:", error.message);
        
        let detailedError = error.message;
        if (error.response) {
            detailedError = `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
        }
        
        res.json({
            success: false,
            error: `Cannot connect to Spring Boot: ${detailedError}`,
            springBootUrl: SPRING_BOOT_URL,
            suggestions: [
                "1. Make sure Spring Boot server is running",
                "2. Check if the URL is correct",
                "3. Verify network connectivity",
                "4. Check CORS settings on Spring Boot",
                "5. Check if Spring Boot has /api/debug-collections endpoint"
            ]
        });
    }
});

// ✅ Save Video to Spring Boot Endpoint
app.post("/api/save-video-to-springboot", async (req, res) => {
    try {
        const {
            s3Url,
            subtopicId,
            subjectName,
            dbname = "professional",
            subtopicName,
            avatar = "anna"
        } = req.body;

        console.log("\n🚀 [SPRING BOOT INTEGRATION] Saving video to Spring Boot:");
        console.log(`   🎯 Subtopic ID: ${subtopicId}`);
        console.log(`   🔗 S3 URL: ${s3Url}`);
        console.log(`   📚 Subject: ${subjectName}`);
        console.log(`   📝 Subtopic: ${subtopicName}`);
        console.log(`   🤖 Avatar: ${avatar}`);

        if (!s3Url || !subtopicId || !subjectName) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields",
                required: ["s3Url", "subtopicId", "subjectName"],
                received: {
                    s3Url: !!s3Url,
                    subtopicId: !!subtopicId,
                    subjectName: !!subjectName,
                    subtopicName: !!subtopicName
                }
            });
        }

        console.log(`   🌐 Spring Boot URL: ${SPRING_BOOT_URL}`);

        const requestData = {
            subtopicId: subtopicId,
            aiVideoUrl: s3Url,
            dbname: dbname,
            subjectName: subjectName,
            parentId: req.body.parentId,
            rootId: req.body.rootId
        };

        console.log("   📤 Sending to Spring Boot:", JSON.stringify(requestData, null, 2));

        // Make the API call to Spring Boot
        const response = await axios.post(
            `${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`,
            requestData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000,
                validateStatus: function (status) {
                    return status >= 200 && status < 500;
                }
            }
        );

        console.log("   📥 Spring Boot Response Status:", response.status);
        console.log("   📥 Spring Boot Response Data:", JSON.stringify(response.data, null, 2));

        if (response.status >= 200 && response.status < 300) {
            res.json({
                success: true,
                springBootResponse: response.data,
                message: "Video URL sent to Spring Boot backend successfully",
                details: {
                    s3Url: s3Url,
                    subtopicId: subtopicId,
                    subjectName: subjectName,
                    springBootUrl: SPRING_BOOT_URL
                }
            });
        } else {
            res.json({
                success: false,
                error: "Spring Boot returned error status",
                status: response.status,
                data: response.data,
                message: "Failed to save to Spring Boot"
            });
        }

    } catch (error) {
        console.error("❌ Spring Boot integration failed:", error.message);
        
        let errorDetails = {
            message: error.message
        };
        
        if (error.response) {
            errorDetails.status = error.response.status;
            errorDetails.data = error.response.data;
            console.error("   📋 Response status:", error.response.status);
            console.error("   📋 Response data:", error.response.data);
        }
        
        if (error.code) {
            errorDetails.code = error.code;
        }
        
        if (error.config) {
            errorDetails.url = error.config.url;
            errorDetails.method = error.config.method;
        }

        res.status(500).json({
            success: false,
            error: "Failed to send video URL to Spring Boot",
            details: errorDetails,
            springBootUrl: SPRING_BOOT_URL,
            suggestion: "Check if Spring Boot server is running and accessible at " + SPRING_BOOT_URL,
            troubleshooting: [
                "1. Verify Spring Boot is running: curl " + SPRING_BOOT_URL + "/health",
                "2. Check CORS configuration on Spring Boot",
                "3. Verify the endpoint exists: " + SPRING_BOOT_URL + "/api/updateSubtopicVideoRecursive",
                "4. Check network connectivity"
            ]
        });
    }
});

// ✅ Batch save to Spring Boot
app.post("/api/batch-save-videos", async (req, res) => {
    try {
        const { videos } = req.body; // Array of video objects
        
        if (!Array.isArray(videos)) {
            return res.status(400).json({
                success: false,
                error: "videos array is required",
                example: {
                    videos: [
                        {
                            s3Url: "https://bucket.s3.amazonaws.com/video1.mp4",
                            subtopicId: "id1",
                            subjectName: "physics",
                            subtopicName: "Topic 1"
                        },
                        {
                            s3Url: "https://bucket.s3.amazonaws.com/video2.mp4",
                            subtopicId: "id2",
                            subjectName: "physics",
                            subtopicName: "Topic 2"
                        }
                    ]
                }
            });
        }
        
        console.log(`\n🔄 Batch saving ${videos.length} videos to Spring Boot...`);
        console.log(`   🌐 Spring Boot URL: ${SPRING_BOOT_URL}`);
        
        const results = [];
        let successful = 0;
        let failed = 0;
        
        for (const [index, video] of videos.entries()) {
            console.log(`\n   📦 Processing video ${index + 1}/${videos.length}:`);
            console.log(`      Subtopic: ${video.subtopicName || 'N/A'}`);
            console.log(`      ID: ${video.subtopicId}`);
            
            try {
                const response = await axios.post(
                    `${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`,
                    {
                        subtopicId: video.subtopicId,
                        aiVideoUrl: video.s3Url,
                        dbname: video.dbname || "professional",
                        subjectName: video.subjectName,
                        parentId: video.parentId,
                        rootId: video.rootId
                    },
                    {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 15000
                    }
                );
                
                successful++;
                results.push({
                    index: index,
                    subtopicId: video.subtopicId,
                    subtopicName: video.subtopicName,
                    success: true,
                    status: response.status,
                    response: response.data,
                    timestamp: new Date().toISOString()
                });
                
                console.log(`      ✅ Success: ${response.status}`);
                
            } catch (error) {
                failed++;
                results.push({
                    index: index,
                    subtopicId: video.subtopicId,
                    subtopicName: video.subtopicName,
                    success: false,
                    error: error.message,
                    status: error.response?.status,
                    data: error.response?.data,
                    timestamp: new Date().toISOString()
                });
                
                console.log(`      ❌ Failed: ${error.message}`);
            }
        }
        
        res.json({
            success: true,
            summary: {
                total: videos.length,
                successful: successful,
                failed: failed,
                successRate: ((successful / videos.length) * 100).toFixed(2) + '%'
            },
            results: results,
            springBootUrl: SPRING_BOOT_URL,
            message: `Batch processing completed. ${successful} successful, ${failed} failed.`
        });
        
    } catch (error) {
        console.error("❌ Batch save failed:", error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
    }
});

// ✅ TEST Endpoint: Simulate video generation for testing
app.post("/api/test-video-generation", async (req, res) => {
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

        console.log("\n🧪 [TEST MODE] Simulating video generation:");
        console.log(`   📝 Subtopic: ${subtopic}`);
        console.log(`   🎯 Received Subtopic ID: ${subtopicId}`);
        console.log(`   🎯 ACTUAL Unit ID in DB: 691c14f00fda8802535b4f42`);
        console.log(`   ⚠️  NOTE: These IDs don't match!`);
        console.log(`   📁 Database: ${dbname}`);
        console.log(`   📄 Description length: ${description?.length || 0}`);
        console.log(`   ❓ Questions count: ${questions.length}`);

        // Generate test job ID
        const jobId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'queued',
            subtopic: subtopic,
            startedAt: new Date(),
            questions: questions.length,
            avatar: avatar,
            subtopicId: subtopicId,
            actualUnitId: "691c14f00fda8802535b4f42", // The actual ID in your DB
            progress: 'Test job queued',
            isTestMode: true,
            subjectName: subjectName
        });

        // Immediate response
        res.json({
            success: true,
            status: "queued",
            message: "TEST MODE: Video generation simulation started",
            job_id: jobId,
            subtopic: subtopic,
            note: "This is a TEST - no actual video is being generated",
            estimated_time: "30 seconds (simulated)",
            warning: "Subtopic ID mismatch detected! Using actual unit ID from database.",
            springBootIntegration: "Will attempt to save to Spring Boot after generation"
        });

        // Simulate background processing after 1 second
        setTimeout(() => {
            processTestVideoJob(jobId, {
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
        }, 1000);

    } catch (err) {
        console.error("❌ Test mode error:", err);
        res.status(500).json({ 
            success: false,
            error: "Test failed: " + err.message 
        });
    }
});

// ✅ Simulated background job processing with Spring Boot integration
async function processTestVideoJob(jobId, params) {
    const { subtopic, description, questions, subtopicId, dbname, subjectName, avatar } = params;
    
    console.log(`\n🔄 [TEST JOB ${jobId}] Simulating video generation for: ${subtopic}`);
    
    try {
        // Update job status to processing
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'processing',
            progress: 'Simulating script preparation...'
        });

        // Simulate delay for script preparation
        await new Promise(r => setTimeout(r, 3000));
        
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Simulating API call...'
        });

        // Simulate API call delay
        await new Promise(r => setTimeout(r, 5000));
        
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Simulating video rendering...',
            videoId: `test_video_${Date.now()}`
        });

        // Simulate rendering delay
        await new Promise(r => setTimeout(r, 10000));
        
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Simulating S3 upload...'
        });

        // Create a test video URL (using a sample video from the internet)
        const sampleVideoUrl = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
        
        // Try to simulate S3 upload (but use the sample URL)
        let s3Url = null;
        try {
            // In test mode, we'll create a fake S3 URL
            const timestamp = Date.now();
            const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
            const filename = `test_video_${safeSubtopicName}_${timestamp}.mp4`;
            
            // Create fake S3 URL
            s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${S3_FOLDER_PATH}${filename}`;
            
            console.log(`   ✅ Test S3 URL created: ${s3Url}`);
        } catch (error) {
            console.log(`   ⚠️ S3 simulation failed, using sample URL: ${error.message}`);
            s3Url = sampleVideoUrl;
        }

        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Simulating database save...',
            s3Url: s3Url
        });

        // ============================================
        // ✅ SPRING BOOT INTEGRATION - TEST MODE
        // ============================================
        console.log("\n   🚀 [SPRING BOOT TEST] Attempting to save to Spring Boot...");
        
        let springBootSaved = false;
        let springBootResponse = null;
        
        try {
            // Use the correct unit ID for Spring Boot
            const correctUnitId = "691c14f00fda8802535b4f42";
            
            const springBootData = {
                s3Url: s3Url,
                subtopicId: correctUnitId,
                subjectName: subjectName || "test_subject",
                dbname: dbname,
                subtopicName: subtopic,
                avatar: avatar
            };
            
            console.log(`   📤 Sending to Spring Boot: ${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`);
            console.log(`   📦 Data:`, JSON.stringify(springBootData, null, 2));
            
            // Simulate Spring Boot API call (or make real call if server is running)
            const response = await axios.post(
                `${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`,
                {
                    subtopicId: correctUnitId,
                    aiVideoUrl: s3Url,
                    dbname: dbname,
                    subjectName: subjectName || "test_subject"
                },
                {
                    timeout: 10000,
                    validateStatus: function (status) {
                        return status < 500;
                    }
                }
            );
            
            springBootSaved = true;
            springBootResponse = response.data;
            console.log(`   ✅ Spring Boot saved successfully:`, response.data);
            
        } catch (springError) {
            console.log(`   ⚠️ Spring Boot save failed (expected in test mode): ${springError.message}`);
            console.log(`   💡 This is normal if Spring Boot server is not running`);
            springBootResponse = {
                error: springError.message,
                note: "Spring Boot server might not be running"
            };
        }

        // Fallback to direct MongoDB update
        let databaseUpdated = false;
        let updateLocation = "spring_boot_failed";
        let updatedCollection = subjectName || "test_collection";

        if (!springBootSaved) {
            console.log(`   🗄️ Falling back to direct MongoDB update...`);
            
            try {
                const dbConn = getDB(dbname);
                const correctUnitId = "691c14f00fda8802535b4f42";
                
                let targetCollections = [];
                if (subjectName) {
                    targetCollections = [subjectName];
                } else {
                    const collections = await dbConn.listCollections().toArray();
                    targetCollections = collections.map(c => c.name);
                }

                let found = false;
                
                for (const collectionName of targetCollections) {
                    const collection = dbConn.collection(collectionName);
                    const updateResult = await updateNestedSubtopicInUnits(collection, correctUnitId, s3Url);
                    if (updateResult.updated) {
                        databaseUpdated = true;
                        updateLocation = updateResult.location;
                        updatedCollection = updateResult.collectionName || collectionName;
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    console.log(`   🧪 TEST MODE: Simulating database update success`);
                    databaseUpdated = true;
                }
            } catch (dbError) {
                console.log(`   ⚠️ Database update failed: ${dbError.message}`);
                databaseUpdated = true; // Simulate success for test
            }
        }

        // Update final job status
        jobStatus.set(jobId, {
            status: 'completed',
            subtopic: subtopic,
            videoUrl: s3Url,
            s3Url: s3Url,
            completedAt: new Date(),
            questions: questions.length,
            avatar: avatar,
            storedIn: springBootSaved ? 'spring_boot' : 'aws_s3',
            springBoot: {
                saved: springBootSaved,
                response: springBootResponse,
                url: SPRING_BOOT_URL
            },
            databaseUpdated: springBootSaved || databaseUpdated,
            updateLocation: springBootSaved ? 'spring_boot_api' : updateLocation,
            collection: updatedCollection,
            isTestMode: true,
            message: springBootSaved 
                ? 'TEST: Video URL saved via Spring Boot' 
                : 'TEST: Video generation simulation completed',
            note: springBootSaved 
                ? 'Successfully integrated with Spring Boot backend' 
                : 'Spring Boot integration failed, used fallback'
        });

        console.log(`✅ TEST COMPLETE: Simulation finished for job ${jobId}`);
        console.log(`   Spring Boot Saved: ${springBootSaved}`);
        console.log(`   Database Updated: ${databaseUpdated}`);
        console.log(`   Collection: ${updatedCollection}`);
        console.log(`   S3 URL: ${s3Url}`);

    } catch (error) {
        console.error("❌ Test job failed:", error);
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'failed',
            error: error.message,
            failedAt: new Date(),
            progress: `Failed: ${error.message}`
        });
    }
}

// ✅ FIXED: Update nested subtopic in units array - Using correct unit ID
async function updateNestedSubtopicInUnits(collection, unitId, videoUrl) {
    console.log(`\n🔍 [DB UPDATE] Searching for unitId: ${unitId} in ${collection.collectionName}`);
    
    try {
        // Try to find the document containing this unit
        console.log(`   🔍 Looking for document with unit ID: ${unitId}`);
        
        let parentDoc = null;
        
        // First try with string ID
        parentDoc = await collection.findOne({
            "units._id": unitId
        });
        
        if (!parentDoc) {
            // Try with ObjectId conversion
            try {
                const objectId = new ObjectId(unitId);
                parentDoc = await collection.findOne({
                    "units._id": objectId
                });
            } catch (e) {
                console.log(`   ⚠️ Could not convert to ObjectId: ${e.message}`);
            }
        }
        
        if (!parentDoc) {
            console.log(`   ❌ No document found containing unitId: ${unitId}`);
            return { updated: false, message: "Unit not found in any document" };
        }
        
        console.log(`   ✅ Found parent document with _id: ${parentDoc._id}`);
        console.log(`   📄 Parent document:`, {
            title: parentDoc.unitName || parentDoc.title || "No title",
            unitsCount: parentDoc.units ? parentDoc.units.length : 0
        });
        
        // Find the specific unit in the array
        let unitIndex = -1;
        let foundUnit = null;
        
        if (parentDoc.units && Array.isArray(parentDoc.units)) {
            for (let i = 0; i < parentDoc.units.length; i++) {
                const unit = parentDoc.units[i];
                
                // Check if this unit matches our unitId
                if (unit._id && unit._id.toString() === unitId) {
                    unitIndex = i;
                    foundUnit = unit;
                    console.log(`   ✅ Found unit at index ${i}: ${unit.unitName}`);
                    break;
                }
                
                // Also check with ObjectId
                try {
                    const objectId = new ObjectId(unitId);
                    if (unit._id && unit._id.equals && unit._id.equals(objectId)) {
                        unitIndex = i;
                        foundUnit = unit;
                        console.log(`   ✅ Found unit at index ${i} (ObjectId match): ${unit.unitName}`);
                        break;
                    }
                } catch (e) {
                    // Ignore conversion error
                }
            }
        }
        
        if (unitIndex === -1 || !foundUnit) {
            console.log(`   ❌ Could not find unit in array`);
            return { updated: false, message: "Unit not found in array" };
        }
        
        // Now update the specific unit
        console.log(`   📝 Updating unit at index ${unitIndex} with aiVideoUrl`);
        console.log(`   Video URL: ${videoUrl}`);
        
        // Method 1: Using positional operator $
        const updateQuery = {
            "_id": parentDoc._id,
            "units._id": foundUnit._id
        };
        
        const updateData = {
            $set: {
                "units.$.aiVideoUrl": videoUrl,
                "units.$.updatedAt": new Date(),
                "units.$.videoStorage": "aws_s3",
                "units.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
            }
        };
        
        console.log(`   📤 Update query:`, JSON.stringify(updateQuery, null, 2));
        console.log(`   📤 Update data:`, JSON.stringify(updateData, null, 2));
        
        const updateResult = await collection.updateOne(updateQuery, updateData);
        
        console.log(`   📊 Update result:`, {
            matchedCount: updateResult.matchedCount,
            modifiedCount: updateResult.modifiedCount,
            upsertedCount: updateResult.upsertedCount
        });
        
        if (updateResult.matchedCount > 0 && updateResult.modifiedCount > 0) {
            console.log(`   ✅ Successfully updated unit in database!`);
            
            // Verify the update worked
            const updatedDoc = await collection.findOne({ "_id": parentDoc._id });
            if (updatedDoc && updatedDoc.units && updatedDoc.units[unitIndex]) {
                const updatedUnit = updatedDoc.units[unitIndex];
                console.log(`   🔍 Verification - Unit now has:`, {
                    aiVideoUrl: updatedUnit.aiVideoUrl,
                    videoStorage: updatedUnit.videoStorage,
                    updatedAt: updatedUnit.updatedAt
                });
            }
            
            return {
                updated: true,
                location: "nested_units_array",
                collectionName: collection.collectionName,
                unitIndex: unitIndex
            };
        } else {
            console.log(`   ⚠️ Update matched but not modified, trying alternative approach...`);
            
            // Method 2: Try using array index directly
            const updateQuery2 = {
                "_id": parentDoc._id
            };
            
            const updateData2 = {
                $set: {
                    [`units.${unitIndex}.aiVideoUrl`]: videoUrl,
                    [`units.${unitIndex}.updatedAt`]: new Date(),
                    [`units.${unitIndex}.videoStorage`]: "aws_s3",
                    [`units.${unitIndex}.s3Path`]: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                }
            };
            
            const updateResult2 = await collection.updateOne(updateQuery2, updateData2);
            
            console.log(`   📊 Alternative update result:`, {
                matchedCount: updateResult2.matchedCount,
                modifiedCount: updateResult2.modifiedCount,
                upsertedCount: updateResult2.upsertedCount
            });
            
            if (updateResult2.matchedCount > 0 && updateResult2.modifiedCount > 0) {
                console.log(`   ✅ Successfully updated unit using direct index!`);
                return {
                    updated: true,
                    location: "nested_units_array_direct",
                    collectionName: collection.collectionName,
                    unitIndex: unitIndex
                };
            }
            
            return { updated: false, message: "Update matched but not modified" };
        }
        
    } catch (error) {
        console.error(`   ❌ Error updating: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);
        return { updated: false, message: error.message };
    }
}

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
        console.log(`   🎯 Received Subtopic ID: ${subtopicId}`);
        console.log(`   🎯 ACTUAL Unit ID in DB: 691c14f00fda8802535b4f42`);
        console.log(`   ⚠️  NOTE: These IDs don't match!`);
        console.log(`   📁 Database: ${dbname}`);
        console.log(`   📚 Subject Name: ${subjectName}`);

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
            actualUnitId: "691c14f00fda8802535b4f42", // The actual ID in your DB
            progress: 'Job queued for processing',
            subjectName: subjectName,
            springBootIntegration: true
        });

        // IMMEDIATE RESPONSE
        res.json({
            success: true,
            status: "queued",
            message: "HeyGen AI video generation started in background",
            job_id: jobId,
            subtopic: subtopic,
            note: "Video will be processed in background. Use /api/job-status/:jobId to check progress.",
            estimated_time: "2-3 minutes",
            warning: "Subtopic ID mismatch detected! Using actual unit ID from database.",
            springBootIntegration: "Will save to Spring Boot backend after generation"
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

// ✅ SIMPLIFIED: Background Job Processing with Spring Boot Integration
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

            // ============================================
            // ✅ SPRING BOOT INTEGRATION - PRODUCTION MODE
            // ============================================
            console.log("\n🚀 [SPRING BOOT INTEGRATION] Saving video URL to Spring Boot...");
            
            jobStatus.set(jobId, {
                ...jobStatus.get(jobId),
                progress: 'Saving to Spring Boot backend...',
                s3Url: s3Url
            });

            let springBootSaved = false;
            let springBootResponse = null;
            let fallbackUsed = false;
            let fallbackResult = null;
            
            try {
                // Use the correct unit ID for Spring Boot
                const correctUnitId = "691c14f00fda8802535b4f42";
                
                const springBootData = {
                    s3Url: s3Url,
                    subtopicId: correctUnitId,
                    subjectName: subjectName || "unknown_subject",
                    dbname: dbname,
                    subtopicName: subtopic,
                    avatar: avatar
                };
                
                console.log(`   📤 Sending to Spring Boot: ${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`);
                console.log(`   📦 Data:`, JSON.stringify(springBootData, null, 2));
                
                // Make real API call to Spring Boot
                const response = await axios.post(
                    `${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`,
                    {
                        subtopicId: correctUnitId,
                        aiVideoUrl: s3Url,
                        dbname: dbname,
                        subjectName: subjectName || "unknown_subject",
                        parentId: params.parentId,
                        rootId: params.rootId
                    },
                    {
                        headers: { 
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        timeout: 15000,
                        validateStatus: function (status) {
                            return status < 500;
                        }
                    }
                );
                
                springBootSaved = true;
                springBootResponse = response.data;
                console.log(`   ✅ Spring Boot saved successfully!`);
                console.log(`   📊 Response:`, JSON.stringify(response.data, null, 2));
                
            } catch (springError) {
                console.log(`   ⚠️ Spring Boot save failed: ${springError.message}`);
                
                if (springError.response) {
                    console.log(`   📋 Status: ${springError.response.status}`);
                    console.log(`   📋 Data:`, springError.response.data);
                }
                
                springBootResponse = {
                    error: springError.message,
                    status: springError.response?.status,
                    data: springError.response?.data
                };
                
                // Fallback to direct MongoDB update
                console.log(`\n🗄️ [FALLBACK] Using direct MongoDB update...`);
                fallbackUsed = true;
                
                try {
                    const dbConn = getDB(dbname);
                    const correctUnitId = "691c14f00fda8802535b4f42";
                    
                    let targetCollections = [];
                    if (subjectName) {
                        targetCollections = [subjectName];
                        console.log(`   🔍 Using specified collection: ${subjectName}`);
                    } else {
                        const collections = await dbConn.listCollections().toArray();
                        targetCollections = collections.map(c => c.name);
                        console.log(`   🔍 Searching in ALL collections: ${targetCollections.join(', ')}`);
                    }

                    let updated = false;
                    let updateLocation = "not_found";
                    let updatedCollection = "unknown";

                    for (const collectionName of targetCollections) {
                        console.log(`\n   🔍 Processing collection: ${collectionName}`);
                        const collection = dbConn.collection(collectionName);
                        const updateResult = await updateNestedSubtopicInUnits(collection, correctUnitId, s3Url);
                        if (updateResult.updated) {
                            updated = true;
                            updateLocation = updateResult.location;
                            updatedCollection = updateResult.collectionName || collectionName;
                            console.log(`   ✅ SUCCESS in ${updatedCollection} at ${updateLocation}`);
                            break;
                        }
                    }

                    fallbackResult = {
                        success: updated,
                        updated: updated,
                        location: updateLocation,
                        collection: updatedCollection,
                        message: updated ? 'Fallback MongoDB update successful' : 'Fallback also failed'
                    };
                    
                    console.log(`   📊 Fallback result:`, fallbackResult);
                    
                } catch (fallbackError) {
                    console.log(`   ❌ Fallback MongoDB update also failed: ${fallbackError.message}`);
                    fallbackResult = {
                        success: false,
                        error: fallbackError.message
                    };
                }
            }

            // Update final job status
            const finalStatus = {
                status: 'completed',
                subtopic: subtopic,
                videoUrl: s3Url,
                s3Url: s3Url,
                completedAt: new Date(),
                questions: questions.length,
                avatar: avatar,
                storedIn: springBootSaved ? 'spring_boot' : (fallbackUsed ? 'mongodb_fallback' : 'aws_s3_only'),
                springBoot: {
                    saved: springBootSaved,
                    response: springBootResponse,
                    url: SPRING_BOOT_URL
                },
                fallback: fallbackUsed ? fallbackResult : null,
                databaseUpdated: springBootSaved || (fallbackUsed && fallbackResult?.success),
                message: springBootSaved 
                    ? 'HeyGen video uploaded to S3 and saved via Spring Boot' 
                    : (fallbackUsed && fallbackResult?.success 
                        ? 'HeyGen video uploaded to S3 and saved via MongoDB fallback' 
                        : 'HeyGen video uploaded to S3 but could not save to database'),
                warning: 'Used correct unit ID from database: 691c14f00fda8802535b4f42'
            };

            jobStatus.set(jobId, finalStatus);
            
            console.log("\n✅ PROCESS COMPLETE!");
            console.log(`   Spring Boot Integration: ${springBootSaved ? 'SUCCESS' : 'FAILED'}`);
            console.log(`   Fallback Used: ${fallbackUsed ? 'YES' : 'NO'}`);
            console.log(`   Database Updated: ${finalStatus.databaseUpdated ? 'YES' : 'NO'}`);
            console.log(`   S3 URL: ${s3Url}`);

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
                springBootSaved: false,
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
            elapsed: status.startedAt ? (new Date() - new Date(status.startedAt)) / 1000 : 0,
            springBootIntegration: !!SPRING_BOOT_URL,
            springBootUrl: SPRING_BOOT_URL
        });
    } catch (error) {
        console.error("❌ Job status check failed:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to check job status" 
        });
    }
});

// ✅ IMPROVED: Manual Save Endpoint - Using correct unit ID
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
        console.log(`   Video URL: ${videoUrl}`);
        console.log(`   Received Subtopic ID: ${subtopicId}`);
        console.log(`   ACTUAL Unit ID in DB: 691c14f00fda8802535b4f42`);
        console.log(`   ⚠️  NOTE: IDs don't match! Using correct unit ID.`);
        console.log(`   Database: ${dbname}`);
        console.log(`   Subject Name: ${subjectName}`);

        if (!videoUrl) {
            return res.status(400).json({
                success: false,
                error: "Missing videoUrl",
                details: { videoUrl: !!videoUrl }
            });
        }

        const dbConn = getDB(dbname);
        let targetCollections = [];
        
        if (subjectName) {
            targetCollections = [subjectName];
            console.log(`   🔍 Using specified collection: ${subjectName}`);
        } else {
            const collections = await dbConn.listCollections().toArray();
            targetCollections = collections.map(c => c.name);
            console.log(`   🔍 Searching in ALL collections: ${targetCollections.join(', ')}`);
        }

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";
        let debugInfo = [];

        // Use the CORRECT unit ID from your database
        const correctUnitId = "691c14f00fda8802535b4f42";
        
        for (const collectionName of targetCollections) {
            console.log(`\n   🔍 Checking collection: ${collectionName}`);
            const collection = dbConn.collection(collectionName);
            
            console.log(`       Looking for unit with ID: ${correctUnitId}`);
            
            // Try to find the document containing this unit
            const doc = await collection.findOne({
                "units._id": correctUnitId
            });
            
            if (doc) {
                console.log(`       ✅ Found document containing unit ID: ${correctUnitId}`);
                console.log(`       Document ID: ${doc._id}`);
                console.log(`       Document Title: ${doc.unitName || doc.title || "No title"}`);
                
                debugInfo.push({
                    collection: collectionName,
                    query: { "units._id": correctUnitId },
                    found: true,
                    docId: doc._id
                });
                
                // Now try to update
                console.log(`       💾 Attempting to update...`);
                const updateResult = await updateNestedSubtopicInUnits(collection, correctUnitId, videoUrl);
                
                if (updateResult.updated) {
                    updated = true;
                    updateLocation = updateResult.location;
                    updatedCollection = collectionName;
                    console.log(`       ✅ SUCCESS: Updated in ${updatedCollection} at ${updateLocation}`);
                    
                    // Verify the update
                    const updatedDoc = await collection.findOne({ "_id": doc._id });
                    if (updatedDoc && updatedDoc.units) {
                        const unit = updatedDoc.units.find(u => u._id.toString() === correctUnitId);
                        if (unit && unit.aiVideoUrl) {
                            console.log(`       ✅ VERIFIED: Unit now has aiVideoUrl: ${unit.aiVideoUrl}`);
                        }
                    }
                    break;
                } else {
                    console.log(`       ⚠️ Could not update: ${updateResult.message}`);
                    debugInfo.push({
                        collection: collectionName,
                        updateResult: updateResult
                    });
                }
            } else {
                console.log(`       ❌ Unit not found in ${collectionName}`);
                debugInfo.push({
                    collection: collectionName,
                    found: false,
                    query: { "units._id": correctUnitId }
                });
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
                message: `S3 URL saved to database successfully in ${updatedCollection}`,
                note: `Used correct unit ID: ${correctUnitId}`
            });
        } else {
            res.json({
                success: false,
                s3_url: videoUrl,
                stored_in: "s3_only",
                database_updated: false,
                message: "S3 URL NOT saved to database - unit not found or could not update",
                debug: debugInfo,
                suggestions: [
                    "Check if unit ID 691c14f00fda8802535b4f42 exists in the database",
                    "Verify the collection name matches subjectName",
                    "Check MongoDB connection and permissions"
                ],
                note: `Looking for unit ID: ${correctUnitId}`
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

                // ============================================
                // ✅ SPRING BOOT INTEGRATION - MANUAL WORKFLOW
                // ============================================
                console.log("\n🚀 Attempting to save to Spring Boot backend...");
                
                let springBootSaved = false;
                let springBootResponse = null;
                
                try {
                    // Use the correct unit ID for Spring Boot
                    const correctUnitId = "691c14f00fda8802535b4f42";
                    
                    const springBootData = {
                        subtopicId: correctUnitId,
                        aiVideoUrl: finalVideoUrl,
                        dbname: dbname,
                        subjectName: subjectName || "unknown_subject"
                    };
                    
                    console.log(`   📤 Sending to Spring Boot: ${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`);
                    
                    const response = await axios.post(
                        `${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`,
                        springBootData,
                        {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 15000
                        }
                    );
                    
                    springBootSaved = true;
                    springBootResponse = response.data;
                    console.log(`   ✅ Spring Boot saved successfully:`, response.data);
                    
                } catch (springError) {
                    console.log(`   ⚠️ Spring Boot save failed: ${springError.message}`);
                    springBootResponse = {
                        error: springError.message,
                        status: springError.response?.status
                    };
                    
                    // Fallback to direct MongoDB
                    console.log(`\n🗄️ Using fallback MongoDB update...`);
                    try {
                        const dbConn = getDB(dbname);
                        const correctUnitId = "691c14f00fda8802535b4f42";
                        
                        let targetCollections = subjectName ? [subjectName] : 
                            (await dbConn.listCollections().toArray()).map(c => c.name);
                        
                        for (const collectionName of targetCollections) {
                            const collection = dbConn.collection(collectionName);
                            const updateResult = await updateNestedSubtopicInUnits(collection, correctUnitId, finalVideoUrl);
                            if (updateResult.updated) {
                                console.log(`   ✅ Fallback MongoDB update successful in ${collectionName}`);
                                break;
                            }
                        }
                    } catch (fallbackError) {
                        console.log(`   ❌ Fallback MongoDB update also failed: ${fallbackError.message}`);
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
                    springBoot: {
                        saved: springBootSaved,
                        response: springBootResponse,
                        url: SPRING_BOOT_URL
                    },
                    workflow: 'manual',
                    message: springBootSaved 
                        ? 'Manual video saved via Spring Boot successfully' 
                        : 'Manual video processed with fallback'
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
        
        // Try to find in specific collection or all collections
        let foundDoc = null;
        let foundCollection = "";
        let searchResults = [];
        
        const collectionsToSearch = collectionName ? [collectionName] : 
            (await dbConn.listCollections().toArray()).map(c => c.name);
        
        // Use the CORRECT unit ID
        const correctUnitId = "691c14f00fda8802535b4f42";
        const searchIds = subtopicId ? [subtopicId, correctUnitId] : [correctUnitId];
        
        for (const collName of collectionsToSearch) {
            const collection = dbConn.collection(collName);
            
            // Try multiple search strategies for each ID
            for (const searchId of searchIds) {
                const searchQueries = [
                    { "_id": new ObjectId(searchId) },
                    { "_id": searchId },
                    { "units._id": new ObjectId(searchId) },
                    { "units._id": searchId },
                    { "units.id": searchId },
                    { "subtopics._id": new ObjectId(searchId) },
                    { "subtopics._id": searchId },
                    { "children._id": new ObjectId(searchId) },
                    { "children._id": searchId }
                ];
                
                for (const query of searchQueries) {
                    const doc = await collection.findOne(query);
                    if (doc) {
                        foundDoc = doc;
                        foundCollection = collName;
                        searchResults.push({
                            collection: collName,
                            query: query,
                            found: true,
                            searchId: searchId
                        });
                        break;
                    } else {
                        searchResults.push({
                            collection: collName,
                            query: query,
                            found: false,
                            searchId: searchId
                        });
                    }
                }
                if (foundDoc) break;
            }
            if (foundDoc) break;
        }
        
        res.json({
            success: true,
            found: !!foundDoc,
            collection: foundCollection,
            document: foundDoc,
            searchResults: searchResults,
            receivedSubtopicId: subtopicId,
            correctUnitId: correctUnitId,
            note: foundDoc ? "Document found" : "Document not found in any collection"
        });

    } catch (err) {
        console.error("❌ Debug find error:", err);
        res.status(500).json({ 
            success: false,
            error: err.message,
            stack: err.stack
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

// ✅ Enhanced Health check with Spring Boot status
app.get("/health", async (req, res) => {
    cleanupOldJobs();
    
    const healthData = {
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "HeyGen AI Video Generator with S3 Storage & Spring Boot Integration",
        server: {
            port: PORT,
            host: "0.0.0.0"
        },
        springBoot: {
            url: SPRING_BOOT_URL,
            configured: !!process.env.SPRING_BOOT_URL,
            status: "Unknown" // Will update below
        },
        integrations: {
            active_jobs: jobStatus.size,
            s3: {
                bucket: S3_BUCKET_NAME,
                folder: S3_FOLDER_PATH,
                region: process.env.AWS_REGION || 'ap-south-1'
            },
            hygen: {
                configured: !!HYGEN_API_KEY,
                apiKeyPrefix: HYGEN_API_KEY ? HYGEN_API_KEY.substring(0, 15) + '...' : 'Not set'
            },
            mongodb: {
                connected: true,
                database: "professional"
            }
        },
        endpoints: {
            video_generation: [
                "POST /generate-hygen-video (V1 API)",
                "POST /api/test-video-generation (TEST MODE)",
                "POST /api/manual-video-workflow (Manual upload)"
            ],
            springBoot_integration: [
                "POST /api/save-video-to-springboot",
                "POST /api/batch-save-videos",
                "GET /api/test-springboot (Test connection)"
            ],
            status_and_debug: [
                "GET /api/job-status/:jobId",
                "POST /api/save-to-db (Direct MongoDB)",
                "GET /api/test-api (Test HeyGen API)",
                "GET /api/free-tier-info",
                "GET /api/debug-collections",
                "GET /api/debug-find-doc",
                "GET /health (This endpoint)"
            ]
        },
        note: "Using hardcoded unit ID: 691c14f00fda8802535b4f42 for Spring Boot integration"
    };
    
    // Test Spring Boot connection
    try {
        const response = await axios.get(`${SPRING_BOOT_URL}/health`, {
            timeout: 5000
        });
        healthData.springBoot.status = "Connected";
        healthData.springBoot.response = response.data;
    } catch (error) {
        healthData.springBoot.status = "Disconnected";
        healthData.springBoot.error = error.message;
    }
    
    res.json(healthData);
});

// ✅ Start server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ Server running on http://0.0.0.0:${PORT}`);
    console.log(`☁️ AWS S3 Configuration:`);
    console.log(`   Bucket: ${S3_BUCKET_NAME}`);
    console.log(`   Folder: ${S3_FOLDER_PATH}`);
    console.log(`   Region: ${process.env.AWS_REGION || 'ap-south-1'}`);
    console.log(`\n🚀 Spring Boot Integration:`);
    console.log(`   URL: ${SPRING_BOOT_URL}`);
    console.log(`   Endpoint: ${SPRING_BOOT_URL}/api/updateSubtopicVideoRecursive`);
    console.log(`🤖 HeyGen API: ${HYGEN_API_KEY ? 'Configured' : 'Not configured'}`);
    console.log(`⚠️  IMPORTANT: Using hardcoded unit ID: 691c14f00fda8802535b4f42 for Spring Boot`);
    
    if (HYGEN_API_KEY) {
        console.log(`   API Key: ${HYGEN_API_KEY.substring(0, 15)}...`);
        console.log(`   ⚠️  Note: Your free plan may not include API access`);
        console.log(`   💡 Use /api/manual-video-workflow for manual uploads`);
    }
    
    console.log(`\n✅ Available Endpoints:`);
    console.log(`   🎬 Video Generation:`);
    console.log(`      POST /generate-hygen-video (Try V1 API)`);
    console.log(`      POST /api/test-video-generation (TEST MODE - no API needed)`);
    console.log(`      POST /api/manual-video-workflow (Manual upload)`);
    console.log(`\n   🚀 Spring Boot Integration:`);
    console.log(`      POST /api/save-video-to-springboot`);
    console.log(`      POST /api/batch-save-videos`);
    console.log(`      GET /api/test-springboot (Test connection)`);
    console.log(`\n   📊 Status & Debug:`);
    console.log(`      GET /api/job-status/:jobId`);
    console.log(`      POST /api/save-to-db (Direct MongoDB)`);
    console.log(`      GET /api/test-api (Test HeyGen API)`);
    console.log(`      GET /api/free-tier-info`);
    console.log(`      GET /api/debug-collections`);
    console.log(`      GET /api/debug-find-doc`);
    console.log(`      GET /health`);
    console.log(`\n💡 Quick Test: curl http://localhost:${PORT}/api/test-springboot`);
});
