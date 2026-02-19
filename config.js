// config.js
require('dotenv').config();

const config = {
  // API Keys
  didApiKey: process.env.DID_API_KEY,
  s3BucketName: process.env.S3_BUCKET_NAME,
  mongoUri: process.env.MONGO_URI,
  port: process.env.PORT || 3000,

  // Backend URLs
  springBootUrl: process.env.SPRING_BOOT_URL,

  // AI Service URL
  aiUrl: process.env.AI_URL,

  // Validate required variables
  validateConfig() {
    const required = ['DID_API_KEY', 'S3_BUCKET_NAME', 'MONGO_URI', 'SPRING_BOOT_URL', 'AI_URL'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:', missing.join(', '));
      return false;
    }
    
    console.log('✅ Configuration loaded successfully');
    console.log('✅ AI_URL:', process.env.AI_URL);
    console.log('✅ SPRING_BOOT_URL:', process.env.SPRING_BOOT_URL);
    return true;
  }
};

// Validate on import
config.validateConfig();

// Use module.exports for CommonJS (Node.js)
module.exports = config;
