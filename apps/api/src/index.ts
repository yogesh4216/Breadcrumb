import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { connectDB } from './db.js';
import { router } from './routes.js';

const app = express();
const PORT = parseInt(process.env.API_PORT || '3001', 10);
const HOST = process.env.API_HOST || '0.0.0.0';

// ─── Sentry Integration ─────────────────────────────────────────────────────

let Sentry: any = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || 'development',
      tracesSampleRate: 1.0,
      integrations: [
        Sentry.expressIntegration({ app }),
      ],
    });
    console.log('Sentry initialized');
  } catch (err) {
    console.warn('Sentry not available, continuing without tracing');
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/api', router);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    name: 'Breadcrumb API',
    version: '0.1.0',
    description: 'AI project navigator for beginner developers',
    docs: '/api/health',
  });
});

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  if (Sentry) Sentry.captureException(err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────

async function start() {
  try {
    // Connect to MongoDB
    await connectDB();
    console.log('MongoDB connected');
  } catch (err) {
    console.warn('MongoDB connection failed, running without persistence:', err);
    // Continue without DB for demo/development
  }

  app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║                                              ║
║   🍞 Breadcrumb API                          ║
║                                              ║
║   Running on http://${HOST}:${PORT}             ║
║                                              ║
║   Endpoints:                                 ║
║   POST /api/projects/analyze                 ║
║   GET  /api/projects                         ║
║   GET  /api/projects/:id                     ║
║   GET  /api/projects/:id/health              ║
║   GET  /api/projects/:id/graph               ║
║   GET  /api/projects/:id/breadcrumb          ║
║   POST /api/projects/:id/breadcrumb/complete ║
║   POST /api/projects/:id/rescan              ║
║   GET  /api/projects/:id/history             ║
║   GET  /api/projects/:id/tasks               ║
║   GET  /api/health                           ║
║                                              ║
╚══════════════════════════════════════════════╝
    `);
  });
}

start();
