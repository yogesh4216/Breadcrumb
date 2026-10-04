import React, { useState, useEffect } from 'react';
import { Play, CheckCircle, AlertTriangle, RefreshCw, Activity, TerminalSquare } from 'lucide-react';

function App() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectPathInput, setProjectPathInput] = useState<string>('/Users/yogeshm/Downloads/Breadccrumb/examples/attendance-demo');
  const [explainData, setExplainData] = useState<any>(null);
  const [explaining, setExplaining] = useState(false);

  const analyzeProject = async () => {
    if (!projectPathInput.trim()) {
      setError('Please enter a valid project path');
      return;
    }
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch('/api/projects/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: projectPathInput.trim() }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to analyze project');
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const completeTask = async () => {
    if (!data?.project?.id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${data.project.id}/breadcrumb/complete`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to complete task');
      const json = await res.json();
      // Update state with next breadcrumb
      setData({
        ...data,
        breadcrumb: json.nextBreadcrumb,
        health: json.health,
        state: json.state,
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const rescanProject = async () => {
    if (!data?.project?.id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${data.project.id}/rescan`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to rescan project');
      const json = await res.json();
      setData({
        ...data,
        breadcrumb: json.breadcrumb,
        health: json.health,
        state: json.state,
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const explainTask = async () => {
    if (!data?.project?.id) return;
    setExplaining(true);
    setExplainData(null);
    try {
      const res = await fetch(`/api/projects/${data.project.id}/breadcrumb/explain`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to fetch explanation');
      const json = await res.json();
      setExplainData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExplaining(false);
    }
  };


  if (!data && !analyzing) {
    return (
      <div className="app-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <h1 style={{ fontSize: '3rem', marginBottom: '1rem' }}>Breadcrumb</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', fontSize: '1.2rem' }}>AI Project Navigator for Beginners</p>
        
        {error && <div className="warning-box" style={{ width: '100%', maxWidth: '600px' }}>
          <h4><AlertTriangle size={18}/> Error</h4>
          <p>{error}</p>
        </div>}

        <div style={{ display: 'flex', gap: '1rem', width: '100%', maxWidth: '700px', marginBottom: '2rem' }}>
          <input 
            type="text" 
            value={projectPathInput}
            onChange={(e) => setProjectPathInput(e.target.value)}
            placeholder="Enter absolute path to your project..."
            style={{ 
              flex: 1, 
              padding: '1rem', 
              borderRadius: '8px', 
              border: '1px solid var(--border)',
              backgroundColor: 'var(--panel-bg)',
              color: 'var(--text-primary)',
              fontSize: '1rem'
            }}
          />
          <button className="primary" onClick={analyzeProject} style={{ padding: '0 2rem', fontSize: '1.1rem' }}>
            <Activity size={20} style={{ marginRight: '0.5rem' }} />
            Analyze
          </button>
        </div>
      </div>
    );
  }

  if (analyzing) {
    return (
      <div className="app-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <RefreshCw size={48} className="spin" style={{ color: 'var(--accent)', marginBottom: '1rem', animation: 'spin 2s linear infinite' }} />
        <h2>Analyzing Repository...</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Extracting dependencies, finding blocked work, consulting Gemma...</p>
        <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const { project, breadcrumb, health, state } = data;

  return (
    <div className="app-container">
      <header>
        <div className="logo">
          🍞 Breadcrumb <span>| {project.name}</span>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={rescanProject} disabled={loading}>
            <RefreshCw size={16} /> Rescan
          </button>
        </div>
      </header>

      {error && <div className="warning-box">
        <h4><AlertTriangle size={18}/> Error</h4>
        <p>{error}</p>
      </div>}

      <div className="dashboard-grid">
        <main>
          {state.scopeRisks?.length > 0 && (
            <div className="warning-box">
              <h4><AlertTriangle size={18}/> SCOPE EXPANSION DETECTED</h4>
              <p>{state.scopeRisks[0].description}</p>
              <p><strong>Recommended:</strong> {state.scopeRisks[0].recommendation}</p>
            </div>
          )}

          <div className="breadcrumb-card">
            <div className="breadcrumb-label">
              <CheckCircle size={16} color="var(--accent)"/> Your Next Breadcrumb
            </div>
            
            <h1 className="breadcrumb-title">{breadcrumb.title}</h1>
            
            <div className="breadcrumb-section">
              <h3>Why this?</h3>
              <p>{breadcrumb.why}</p>
            </div>

            <div className="breadcrumb-section">
              <h3>Done When</h3>
              <ul className="done-criteria">
                {breadcrumb.doneWhen.map((criteria: string, idx: number) => (
                  <li key={idx}>{criteria}</li>
                ))}
              </ul>
            </div>

            <div className="breadcrumb-section">
              <h3>Evidence</h3>
              <div className="evidence-list">
                {breadcrumb.evidence.map((ev: any, idx: number) => (
                  <div key={idx} className="evidence-item">
                    <span className="evidence-file">{ev.file}</span>
                    <span className="evidence-reason">// {ev.reason}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="actions">
              <button className="primary" onClick={completeTask} disabled={loading}>
                <CheckCircle size={18} /> Mark as Complete
              </button>
              <button onClick={explainTask} disabled={explaining || loading}>
                <TerminalSquare size={18} /> {explaining ? 'Explaining...' : 'Explain Mode'}
              </button>
              <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', alignSelf: 'center' }}>
                ~{breadcrumb.estimatedMinutes} mins
              </span>
            </div>
          </div>
        </main>

        <aside>
          <div className="panel">
            <h2>Project Health</h2>
            
            <div className="health-stat">
              <span className="label">Core Progress</span>
              <span className="value" style={{ color: health.coreProgress > 50 ? 'var(--success)' : 'var(--warning)' }}>
                {health.coreProgress}%
              </span>
            </div>
            
            <div className="health-stat">
              <span className="label">Blocked Tasks</span>
              <span className="value" style={{ color: health.blockedTasks > 0 ? 'var(--danger)' : 'var(--text-primary)' }}>
                {health.blockedTasks}
              </span>
            </div>
            
            <div className="health-stat">
              <span className="label">Unimplemented</span>
              <span className="value">{health.unimplementedTasks}</span>
            </div>
            
            <div className="health-stat">
              <span className="label">Scope Risks</span>
              <span className="value" style={{ color: health.scopeRisks > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>
                {health.scopeRisks}
              </span>
            </div>
            
            <div className="health-stat">
              <span className="label">Dependency Health</span>
              <span className="value" style={{ 
                color: health.dependencyHealth === 'good' ? 'var(--success)' : 
                       health.dependencyHealth === 'warning' ? 'var(--warning)' : 'var(--danger)' 
              }}>
                {health.dependencyHealth.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="panel">
            <h2>Timeline</h2>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ color: 'var(--text-primary)' }}>{new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - Repository scanned</div>
                <div style={{ fontSize: '0.8rem' }}>{state.modules.length} modules detected</div>
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ color: 'var(--text-primary)' }}>{new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - Graph generated</div>
                <div style={{ fontSize: '0.8rem' }}>{state.dependencies.length} dependencies mapped</div>
              </div>
              <div>
                <div style={{ color: 'var(--accent)' }}>{new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - Breadcrumb Selected</div>
                <div style={{ fontSize: '0.8rem' }}>{breadcrumb.title}</div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {explainData && (
        <div className="modal-overlay" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000
        }}>
          <div className="modal-content" style={{
            backgroundColor: 'var(--panel-bg)', padding: '2rem', borderRadius: '8px', maxWidth: '800px', width: '90%', maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <h2 style={{ color: 'var(--accent)', marginTop: 0 }}>Gemma Explanation: {explainData.concept}</h2>
              <button onClick={() => setExplainData(null)} style={{ padding: '0.5rem 1rem' }}>Close</button>
            </div>
            <p style={{ fontSize: '1.1rem', lineHeight: 1.6, marginBottom: '1.5rem', color: 'var(--text-primary)' }}>{explainData.explanation}</p>
            
            {explainData.relevantFiles?.length > 0 && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ color: 'var(--text-secondary)' }}>Relevant Files</h3>
                <ul style={{ paddingLeft: '1.5rem', color: 'var(--text-primary)' }}>
                  {explainData.relevantFiles.map((f: string, i: number) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {explainData.codeSnippets?.length > 0 && (
              <div>
                <h3 style={{ color: 'var(--text-secondary)' }}>Code Snippets</h3>
                {explainData.codeSnippets.map((snippet: any, i: number) => (
                  <div key={i} style={{ marginBottom: '1rem', backgroundColor: 'var(--bg)', padding: '1rem', borderRadius: '4px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.9rem', color: 'var(--accent)', marginBottom: '0.5rem', fontFamily: 'monospace' }}>{snippet.file}</div>
                    <pre style={{ margin: 0, overflowX: 'auto', color: 'var(--text-primary)', padding: '1rem', backgroundColor: '#1a1a1a', borderRadius: '4px' }}>
                      <code>{snippet.code}</code>
                    </pre>
                    <p style={{ marginTop: '0.5rem', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{snippet.explanation}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
