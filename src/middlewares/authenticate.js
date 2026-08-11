const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token)
    return res.status(401).json({ error: 'Access denied. No token provided.' });

  try {
    // Pin the accepted algorithm to what generateToken.js actually signs
    // with (jsonwebtoken's HS256 default) rather than trusting whatever
    // algorithm the token's own header claims. Without this, a token
    // whose header says "alg: none" or an unexpected algorithm still gets
    // handed to jwt.verify, which is the shape of classic JWT
    // algorithm-confusion attacks — closing this off protects every
    // authenticated route this middleware guards, order creation and
    // payment included, not just one endpoint.
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    next();
  } catch (ex) {
    res.status(400).json({ error: 'Invalid token.' });
  }
};
