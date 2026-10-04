import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import type {
  Project,
  ProjectSnapshot,
  BreadcrumbTask,
  TimelineEntry,
  AgentRun,
  ProjectState,
  DependencyGraph,
  ProjectHealth,
} from '@breadcrumb/shared';

// ─── Database Connection ─────────────────────────────────────────────────────

let client: MongoClient | null = null;
let db: Db | null = null;
let isConnected = false;

// In-memory fallback stores
const mockDb = {
  projects: [] as any[],
  project_snapshots: [] as any[],
  tasks: [] as any[],
  timeline: [] as any[],
  agent_runs: [] as any[]
};

export async function connectDB(uri?: string): Promise<Db | null> {
  if (db) return db;

  const mongoUri = uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/breadcrumb';

  try {
    client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
  db = client.db();

  // Create indexes
  await db.collection('projects').createIndex({ path: 1 }, { unique: true });
  await db.collection('project_snapshots').createIndex({ projectId: 1, timestamp: -1 });
  await db.collection('tasks').createIndex({ projectId: 1, status: 1 });
  await db.collection('tasks').createIndex({ projectId: 1, createdAt: -1 });
  await db.collection('timeline').createIndex({ projectId: 1, timestamp: -1 });
  await db.collection('agent_runs').createIndex({ projectId: 1, startedAt: -1 });

    console.log('Connected to MongoDB');
    isConnected = true;
    return db;
  } catch (err) {
    console.warn('MongoDB connection failed, using in-memory mock storage');
    isConnected = false;
    return null;
  }
}

export async function disconnectDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export function getDb(): Db | null {
  return db;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export async function createProject(project: Omit<Project, 'id'>): Promise<Project> {
  const doc = { ...project, createdAt: new Date(), updatedAt: new Date(), id: randomUUID(), _id: new ObjectId() };
  if (isConnected && db) {
    const col = db.collection('projects');
    const result = await col.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() } as Project;
  }
  mockDb.projects.push(doc);
  return doc as unknown as Project;
}

export async function getProject(id: string): Promise<Project | null> {
  if (isConnected && db) {
    const col = db.collection('projects');
    const doc = await col.findOne({ _id: new ObjectId(id) });
    if (!doc) return null;
    return { ...doc, id: doc._id.toString() } as unknown as Project;
  }
  return mockDb.projects.find(p => p.id === id) || null;
}

export async function getProjectByPath(path: string): Promise<Project | null> {
  if (isConnected && db) {
    const col = db.collection('projects');
    const doc = await col.findOne({ path });
    if (!doc) return null;
    return { ...doc, id: doc._id.toString() } as unknown as Project;
  }
  return mockDb.projects.find(p => p.path === path) || null;
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<void> {
  if (isConnected && db) {
    const col = db.collection('projects');
    await col.updateOne({ _id: new ObjectId(id) }, { $set: { ...updates, updatedAt: new Date() } });
    return;
  }
  const idx = mockDb.projects.findIndex(p => p.id === id);
  if (idx !== -1) mockDb.projects[idx] = { ...mockDb.projects[idx], ...updates, updatedAt: new Date() };
}

export async function listProjects(): Promise<Project[]> {
  if (isConnected && db) {
    const col = db.collection('projects');
    const docs = await col.find().sort({ updatedAt: -1 }).toArray();
    return docs.map(doc => ({ ...doc, id: doc._id.toString() })) as unknown as Project[];
  }
  return [...mockDb.projects].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// ─── Project Snapshots ───────────────────────────────────────────────────────

export async function saveSnapshot(
  projectId: string,
  state: ProjectState,
  graph: DependencyGraph,
  health: ProjectHealth,
  commitHash?: string
): Promise<string> {
  const doc = { projectId, timestamp: new Date(), state, graph, health, commitHash, _id: new ObjectId() };
  if (isConnected && db) {
    const col = db.collection('project_snapshots');
    const result = await col.insertOne(doc);
    return result.insertedId.toString();
  }
  mockDb.project_snapshots.push(doc);
  return doc._id.toString();
}

export async function getLatestSnapshot(projectId: string): Promise<any | null> {
  if (isConnected && db) {
    const col = db.collection('project_snapshots');
    return col.findOne({ projectId }, { sort: { timestamp: -1 } });
  }
  const snaps = mockDb.project_snapshots.filter(s => s.projectId === projectId);
  return snaps.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0] || null;
}

export async function getSnapshotHistory(projectId: string, limit = 20): Promise<any[]> {
  if (isConnected && db) {
    const col = db.collection('project_snapshots');
    return col.find({ projectId }).sort({ timestamp: -1 }).limit(limit).toArray();
  }
  return mockDb.project_snapshots
    .filter(s => s.projectId === projectId)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export async function saveTask(task: BreadcrumbTask): Promise<void> {
  if (isConnected && db) {
    const col = db.collection('tasks');
    await col.insertOne({ ...task, _id: undefined });
    return;
  }
  mockDb.tasks.push(task);
}

export async function getActiveTask(projectId: string): Promise<BreadcrumbTask | null> {
  if (isConnected && db) {
    const col = db.collection('tasks');
    const doc = await col.findOne({ projectId, status: { $in: ['pending', 'active'] } }, { sort: { createdAt: -1 } });
    return doc as unknown as BreadcrumbTask | null;
  }
  const tasks = mockDb.tasks.filter(t => t.projectId === projectId && ['pending', 'active'].includes(t.status));
  return tasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] || null;
}

export async function updateTaskStatus(taskId: string, status: string, verificationResults?: any[]): Promise<void> {
  const updates: any = { status };
  if (status === 'active') updates.startedAt = new Date();
  if (status === 'completed' || status === 'verified') {
    updates.completedAt = new Date();
    if (verificationResults) updates.verificationResults = verificationResults;
  }
  
  if (isConnected && db) {
    const col = db.collection('tasks');
    await col.updateOne({ id: taskId }, { $set: updates });
    return;
  }
  
  const idx = mockDb.tasks.findIndex(t => t.id === taskId);
  if (idx !== -1) mockDb.tasks[idx] = { ...mockDb.tasks[idx], ...updates };
}

export async function getTaskHistory(projectId: string, limit = 50): Promise<BreadcrumbTask[]> {
  if (isConnected && db) {
    const col = db.collection('tasks');
    const docs = await col.find({ projectId }).sort({ createdAt: -1 }).limit(limit).toArray();
    return docs as unknown as BreadcrumbTask[];
  }
  return mockDb.tasks
    .filter(t => t.projectId === projectId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export async function addTimelineEntry(entry: Omit<TimelineEntry, 'id'>): Promise<void> {
  const doc = { ...entry, timestamp: new Date(), _id: new ObjectId(), id: randomUUID() };
  if (isConnected && db) {
    const col = db.collection('timeline');
    await col.insertOne(doc);
    return;
  }
  mockDb.timeline.push(doc);
}

export async function getTimeline(projectId: string, limit = 50): Promise<TimelineEntry[]> {
  if (isConnected && db) {
    const col = db.collection('timeline');
    const docs = await col.find({ projectId }).sort({ timestamp: -1 }).limit(limit).toArray();
    return docs.map(d => ({ ...d, id: d._id.toString() })) as unknown as TimelineEntry[];
  }
  return mockDb.timeline
    .filter(t => t.projectId === projectId)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}

// ─── Agent Runs ──────────────────────────────────────────────────────────────

export async function saveAgentRun(run: AgentRun): Promise<void> {
  if (isConnected && db) {
    const col = db.collection('agent_runs');
    await col.insertOne(run);
    return;
  }
  mockDb.agent_runs.push(run);
}

export async function getLatestAgentRun(projectId: string): Promise<AgentRun | null> {
  if (isConnected && db) {
    const col = db.collection('agent_runs');
    const doc = await col.findOne({ projectId }, { sort: { startedAt: -1 } });
    return doc as unknown as AgentRun | null;
  }
  const runs = mockDb.agent_runs.filter(r => r.projectId === projectId);
  return runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] || null;
}
