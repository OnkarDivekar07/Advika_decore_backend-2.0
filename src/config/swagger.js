// src/config/swagger.js
const swaggerJSDoc = require('swagger-jsdoc');
const path = require('path');
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Advika Decore API',
      version: '1.0.0',
      description: 'API documentation for Advika backend',
    },
    servers: [
      {
        url: 'http://localhost:5000',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [
    path.join(__dirname, '../routes/*.js'),
    path.join(__dirname, '../modules/**/*.js'),
    path.join(__dirname, '../docs/*.js'),
  ],
};

const swaggerSpec = swaggerJSDoc(options);

module.exports = swaggerSpec;
