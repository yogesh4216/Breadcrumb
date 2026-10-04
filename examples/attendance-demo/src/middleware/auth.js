// TODO: Implement authentication middleware
// Should verify JWT token from Authorization header
// Should attach user info to request
// Used by admin routes

const authenticateUser = (req, res, next) => {
  // TODO: Implement JWT verification
  // const token = req.headers.authorization?.split(' ')[1];
  // if (!token) return res.status(401).json({ error: 'No token provided' });
  next();
};

module.exports = { authenticateUser };
