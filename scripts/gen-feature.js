const fs = require('fs');
const path = require('path');

const featureName = process.argv[2];

if (!featureName) {
  console.error(
    '❌ Please provide a feature name. Example: node scripts/gen-feature.js user'
  );
  process.exit(1);
}

const basePath = path.join(
  __dirname,
  '../src/modules',
  featureName.toLowerCase()
);
const files = {
  [`${featureName}.controller.js`]: `// ${featureName} controller\nmodule.exports = {};`,
  [`${featureName}.service.js`]: `// ${featureName} service\nmodule.exports = {};`,
  [`${featureName}.model.js`]: `// ${featureName} model access (using Prisma)\nmodule.exports = {};`,
  [`${featureName}.routes.js`]: `// ${featureName} routes\nconst express = require('express');\nconst router = express.Router();\n\n// Add your routes here\n\nmodule.exports = router;`,
  [`${featureName}.validation.js`]: `// ${featureName} validation schemas\nmodule.exports = {};`,
  [`index.js`]: `// Barrel file to export all ${featureName} modules\n\nmodule.exports = {\n  controller: require('./${featureName}.controller'),\n  service: require('./${featureName}.service'),\n  model: require('./${featureName}.model'),\n  routes: require('./${featureName}.routes'),\n  validation: require('./${featureName}.validation'),\n};`,
};

if (!fs.existsSync(basePath)) {
  fs.mkdirSync(basePath, { recursive: true });
  console.log(`📁 Created directory: ${basePath}`);
} else {
  console.log(`📁 Directory already exists: ${basePath}`);
}

for (const [fileName, content] of Object.entries(files)) {
  const filePath = path.join(basePath, fileName);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
    console.log(`✅ Created: ${filePath}`);
  } else {
    console.log(`⚠️ Skipped (already exists): ${filePath}`);
  }
}
