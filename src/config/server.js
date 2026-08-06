const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const errorHandler = require('../middlewares/errorHandler');

const app = express();

// Global middlewares
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// All route registrations go here later
// app.use('/api/v1/users', userRoutes);

app.use(errorHandler); // Catch-all error middleware

module.exports = app; // Export ready-to-run app instance
