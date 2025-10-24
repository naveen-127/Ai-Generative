const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS configuration
const allowedOrigins = [
  "https://majestic-frangollo-031fed.netlify.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://padmasini7-frontend.netlify.app",
  "https://ai-generative-rhk1.onrender.com",
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS policy violation'), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));

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

// ✅ Helper function to get database connection
function getDB(dbname = "professional") {
  return client.db(dbname);
}

// ✅ D-ID API key
if (!process.env.DID_API_KEY) {
  console.error("❌ Missing DID_API_KEY in .env");
  process.exit(1);
}
const DID_API_KEY = `Basic ${Buffer.from(process.env.DID_API_KEY).toString("base64")}`;

// ✅ Generate AI video (D-ID)
app.post("/generate-and-upload", async (req, res) => {
  try {
    const { subtopic, description } = req.body;

    if (!subtopic || !description || description.trim().length < 3) {
      return res.status(400).json({
        error: "Description must be at least 3 characters for AI video generation."
      });
    }

    console.log("🎬 Starting AI video generation for:", subtopic);

    const didResponse = await axios.post(
      "https://api.d-id.com/talks",
      {
        script: { type: "text", input: description, subtitles: "false" },
        presenter_id: "amy-jcwqj4g",
      },
      {
        headers: { Authorization: DID_API_KEY, "Content-Type": "application/json" },
        timeout: 120000,
      }
    );

    const talkId = didResponse.data.id;
    let videoUrl = "";
    let status = "notDone";

    console.log("⏳ Polling for video status, talkId:", talkId);

    const startTime = Date.now();
    const maxWaitTime = 10 * 60 * 1000;

    while (status !== "done" && (Date.now() - startTime) < maxWaitTime) {
      const poll = await axios.get(`https://api.d-id.com/talks/${talkId}`, {
        headers: { Authorization: DID_API_KEY },
        timeout: 30000,
      });

      status = poll.data.status;
      console.log("📊 Video status:", status);

      if (status === "done") {
        videoUrl = poll.data.result_url;
        console.log("✅ D-ID Video ready:", videoUrl);
        break;
      } else if (status === "failed") {
        throw new Error("D-ID video generation failed");
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (status !== "done") {
      throw new Error("Video generation timeout");
    }

    res.json({
      firebase_video_url: videoUrl,
      message: "AI video generated successfully"
    });
  } catch (err) {
    console.error("❌ D-ID API Error:", err.response?.data || err.message || err);
    res.status(500).json({
      error: err.response?.data?.details || err.response?.data?.error || err.message || "Video generation failed"
    });
  }
});

// ✅ FIXED: Debug endpoint for Spring Boot MongoDB structure
app.get("/api/debug-subtopic/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { dbname = "professional", subjectName } = req.query;

    console.log("🔍 Debugging subtopic in Spring Boot structure:", id);

    const dbConn = getDB(dbname);

    // Determine which collections to search
    const collectionsToSearch = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

    let foundSubtopic = null;
    let foundCollection = null;
    let foundLocation = null;
    let foundField = null;

    for (const collectionName of collectionsToSearch) {
      const collection = dbConn.collection(collectionName);

      console.log(`🔍 Searching in collection: ${collectionName}`);

      // Search 1: As main document with ObjectId
      try {
        const mainDoc = await collection.findOne({ _id: new ObjectId(id) });
        if (mainDoc) {
          foundSubtopic = mainDoc;
          foundCollection = collectionName;
          foundLocation = "main_document";
          foundField = "_id";
          console.log(`✅ Found as main document in ${collectionName}`);
          break;
        }
      } catch (e) {
        // Not a valid ObjectId, continue
      }

      // Search 2: As main document with string ID
      const mainDocString = await collection.findOne({ _id: id });
      if (mainDocString) {
        foundSubtopic = mainDocString;
        foundCollection = collectionName;
        foundLocation = "main_document";
        foundField = "_id (string)";
        console.log(`✅ Found as main document with string ID in ${collectionName}`);
        break;
      }

      // Search 3: In units array with _id field
      const parentWithUnitsId = await collection.findOne({
        "units._id": id
      });

      if (parentWithUnitsId) {
        const parentDoc = parentWithUnitsId;
        const nestedUnit = parentDoc.units.find(unit => unit._id === id);
        if (nestedUnit) {
          foundSubtopic = nestedUnit;
          foundCollection = collectionName;
          foundLocation = "nested_in_units";
          foundField = "units._id";
          foundSubtopic.parentDocument = {
            _id: parentDoc._id,
            unitName: parentDoc.unitName
          };
          console.log(`✅ Found as nested unit with _id in ${collectionName}`);
          break;
        }
      }

      // Search 4: In units array with id field
      const parentWithUnits = await collection.findOne({
        "units.id": id
      });

      if (parentWithUnits) {
        const parentDoc = parentWithUnits;
        const nestedUnit = parentDoc.units.find(unit => unit.id === id);
        if (nestedUnit) {
          foundSubtopic = nestedUnit;
          foundCollection = collectionName;
          foundLocation = "nested_in_units";
          foundField = "units.id";
          foundSubtopic.parentDocument = {
            _id: parentDoc._id,
            unitName: parentDoc.unitName
          };
          console.log(`✅ Found as nested unit with id in ${collectionName}`);
          break;
        }
      }

      // Search 5: In any array field containing objects with _id
      const anyArrayDoc = await collection.findOne({
        $or: [
          { "units._id": id },
          { "units.id": id },
          { "subtopics._id": id },
          { "subtopics.id": id },
          { "children._id": id },
          { "children.id": id }
        ]
      });

      if (anyArrayDoc) {
        // Find which array and which field
        const arraysToCheck = ['units', 'subtopics', 'children'];
        for (const arrayField of arraysToCheck) {
          if (anyArrayDoc[arrayField]) {
            const foundUnit = anyArrayDoc[arrayField].find(item =>
              item._id === id || item.id === id
            );
            if (foundUnit) {
              foundSubtopic = foundUnit;
              foundCollection = collectionName;
              foundLocation = `nested_in_${arrayField}`;
              foundField = `${arrayField}.${foundUnit._id === id ? '_id' : 'id'}`;
              foundSubtopic.parentDocument = {
                _id: anyArrayDoc._id,
                unitName: anyArrayDoc.unitName
              };
              console.log(`✅ Found in ${arrayField} array in ${collectionName}`);
              break;
            }
          }
        }
        if (foundSubtopic) break;
      }
    }

    if (foundSubtopic) {
      res.json({
        found: true,
        location: foundLocation,
        collection: foundCollection,
        field: foundField,
        subtopic: foundSubtopic,
        message: "Subtopic found successfully"
      });
    } else {
      // Enhanced debugging: Show what's actually in the target collection
      const debugInfo = {};
      for (const collectionName of collectionsToSearch.slice(0, 2)) {
        const collection = dbConn.collection(collectionName);
        const sampleDocs = await collection.find({}).limit(2).toArray();

        debugInfo[collectionName] = sampleDocs.map(doc => {
          const docInfo = {
            _id: doc._id,
            unitName: doc.unitName,
            hasUnits: !!doc.units,
          };

          if (doc.units) {
            docInfo.units = doc.units.map(unit => ({
              _id: unit._id,
              id: unit.id,
              unitName: unit.unitName,
              matchesSearch: (unit._id === id || unit.id === id)
            }));
          }

          return docInfo;
        });
      }

      res.json({
        found: false,
        message: "Subtopic not found in any collection",
        debug: {
          searchedId: id,
          collectionsSearched: collectionsToSearch,
          sampleData: debugInfo,
          suggestion: "Check if the subtopic was properly saved with the correct ID field"
        }
      });
    }

  } catch (err) {
    console.error("❌ Debug error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ FIXED: Update Subtopic AI Video URL for Spring Boot structure
app.put("/api/updateSubtopicVideo", async (req, res) => {
  try {
    const { subtopicId, parentId, aiVideoUrl, dbname = "professional", subjectName } = req.body;

    console.log("🔄 Updating subtopic AI video:", { subtopicId, parentId, aiVideoUrl, dbname, subjectName });

    if (!subtopicId || !aiVideoUrl) {
      return res.status(400).json({
        error: "Missing subtopicId or aiVideoUrl"
      });
    }

    const dbConn = getDB(dbname);
    let result;
    let updateLocation = "unknown";
    let updatedCollection = "unknown";
    let updateField = "unknown";

    // Determine which collection to search in
    const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

    console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);

    for (const collectionName of targetCollections) {
      const collection = dbConn.collection(collectionName);
      console.log(`🔍 Attempting update in collection: ${collectionName}`);

      // Try multiple update strategies

      // Strategy 1: Update nested unit using units._id field
      // Strategy 1: Update nested unit using units._id (with ObjectId)
      try {
        result = await collection.updateOne(
          { "units._id": new ObjectId(subtopicId) },
          {
            $set: {
              "units.$.aiVideoUrl": aiVideoUrl,
              "units.$.updatedAt": new Date()
            }
          }
        );

        if (result.matchedCount > 0) {
          updateLocation = "nested_unit_ObjectId";
          updatedCollection = collectionName;
          updateField = "units._id (ObjectId)";
          console.log(`✅ Updated nested unit using units._id (ObjectId) in ${collectionName}`);
          break;
        }
      } catch (e) {
        console.log(`⚠️ Could not cast subtopicId to ObjectId: ${e.message}`);
      }
      console.log("🧠 MongoDB update result:", result);


      if (result.matchedCount > 0) {
        updateLocation = "nested_unit";
        updatedCollection = collectionName;
        updateField = "units._id";
        console.log(`✅ Updated nested unit using units._id in ${collectionName}`);
        break;
      }

      // Strategy 2: Update nested unit using units.id field
      result = await collection.updateOne(
        { "units.id": subtopicId },
        {
          $set: {
            "units.$.aiVideoUrl": aiVideoUrl,
            "units.$.updatedAt": new Date()
          }
        }
      );

      if (result.matchedCount > 0) {
        updateLocation = "nested_unit";
        updatedCollection = collectionName;
        updateField = "units.id";
        console.log(`✅ Updated nested unit using units.id in ${collectionName}`);
        break;
      }

      // Strategy 3: Update as main document with ObjectId
      try {
        result = await collection.updateOne(
          { _id: new ObjectId(subtopicId) },
          {
            $set: {
              aiVideoUrl: aiVideoUrl,
              updatedAt: new Date()
            }
          }
        );

        if (result.matchedCount > 0) {
          updateLocation = "main_document";
          updatedCollection = collectionName;
          updateField = "_id (ObjectId)";
          console.log(`✅ Updated main document with ObjectId in ${collectionName}`);
          break;
        }
      } catch (e) {
        console.log(`⚠️ Could not use ObjectId for ${subtopicId}: ${e.message}`);
      }

      // Strategy 4: Update as main document with string ID
      result = await collection.updateOne(
        { _id: subtopicId },
        {
          $set: {
            aiVideoUrl: aiVideoUrl,
            updatedAt: new Date()
          }
        }
      );

      if (result.matchedCount > 0) {
        updateLocation = "main_document";
        updatedCollection = collectionName;
        updateField = "_id (string)";
        console.log(`✅ Updated main document with string ID in ${collectionName}`);
        break;
      }

      // Strategy 5: Use arrayFilters for complex nested updates
      try {
        // This handles cases where we need to update a specific element in an array
        result = await collection.updateOne(
          { "units": { $exists: true } },
          {
            $set: {
              "units.$[unit].aiVideoUrl": aiVideoUrl,
              "units.$[unit].updatedAt": new Date()
            }
          },
          {
            arrayFilters: [
              {
                $or: [
                  { "unit._id": subtopicId },
                  { "unit.id": subtopicId }
                ]
              }
            ]
          }
        );

        if (result.matchedCount > 0) {
          updateLocation = "nested_unit_arrayFilters";
          updatedCollection = collectionName;
          updateField = "arrayFilters";
          console.log(`✅ Updated using arrayFilters in ${collectionName}`);
          break;
        }
      } catch (e) {
        console.log(`⚠️ Array filters failed: ${e.message}`);
      }
    }

    console.log("🔍 Final update result - Matched:", result?.matchedCount, "Modified:", result?.modifiedCount);

    if (!result || result.matchedCount === 0) {
      console.log("❌ No documents matched in any collection.");

      // Enhanced debugging: Show what's actually in the database
      let debugInfo = {};
      for (const collectionName of targetCollections.slice(0, 2)) {
        const collection = dbConn.collection(collectionName);
        const sampleDocs = await collection.find({}).limit(3).toArray();
        debugInfo[collectionName] = sampleDocs.map(doc => {
          const docInfo = {
            _id: doc._id,
            unitName: doc.unitName,
            hasUnits: !!doc.units,
          };

          if (doc.units) {
            docInfo.units = doc.units.map(unit => ({
              _id: unit._id,
              id: unit.id,
              unitName: unit.unitName
            }));
          }

          return docInfo;
        });
      }

      return res.status(404).json({
        error: "Subtopic not found. The subtopic might not exist or was not saved properly.",
        subtopicId: subtopicId,
        debug: {
          collectionsSearched: targetCollections,
          sampleData: debugInfo,
          suggestion: "Make sure the subtopic was saved via Spring Boot backend first and check the ID field used"
        }
      });
    }

    console.log("✅ AI video URL saved successfully! Location:", updateLocation, "Collection:", updatedCollection, "Field:", updateField);

    res.json({
      status: "ok",
      updated: result.modifiedCount,
      matched: result.matchedCount,
      location: updateLocation,
      collection: updatedCollection,
      field: updateField,
      message: "AI video URL saved successfully"
    });

  } catch (err) {
    console.error("❌ Error updating subtopic:", err);
    res.status(500).json({ error: "Failed to update subtopic: " + err.message });
  }
});

// ✅ NEW: Enhanced debug endpoint that searches across all collections
app.get("/api/debug-subtopic-all/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { dbname = "professional" } = req.query;

    console.log("🔍 Debugging subtopic across ALL collections:", id);

    const dbConn = getDB(dbname);
    const collections = await dbConn.listCollections().toArray();
    const results = {};

    for (const collectionInfo of collections) {
      const collectionName = collectionInfo.name;
      const collection = dbConn.collection(collectionName);

      console.log(`🔍 Searching in collection: ${collectionName}`);

      // Search as nested unit with _id
      const nestedResultId = await collection.findOne({ "units._id": id });

      // Search as nested unit with id
      const nestedResult = await collection.findOne({ "units.id": id });

      // Search as main document with ObjectId
      let mainResult = null;
      try {
        mainResult = await collection.findOne({ _id: new ObjectId(id) });
      } catch (e) {
        // Ignore ObjectId errors
      }

      // Search as main document with string
      const mainResultString = await collection.findOne({ _id: id });

      if (nestedResultId || nestedResult || mainResult || mainResultString) {
        results[collectionName] = {
          foundAsNestedWith_Id: !!nestedResultId,
          foundAsNestedWithId: !!nestedResult,
          foundAsMain: !!(mainResult || mainResultString),
          document: nestedResultId || nestedResult || mainResult || mainResultString
        };
      }
    }

    res.json({
      found: Object.keys(results).length > 0,
      subtopicId: id,
      results: results,
      collectionsSearched: collections.map(c => c.name)
    });

  } catch (err) {
    console.error("❌ Debug all error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    service: "Node.js AI Video Backend"
  });
});

app.get("/api/test", (req, res) => {
  res.json({
    message: "Node.js backend is working!",
    purpose: "AI Video Generation for Spring Boot subtopics"
  });
});

// ✅ Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Node.js Server running on http://0.0.0.0:${PORT}`);
  console.log(`✅ Configured for Spring Boot MongoDB structure`);
  console.log(`✅ AI Video Generation Service Ready`);
});