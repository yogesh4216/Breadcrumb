import React, { useState, useEffect } from 'react';

// TODO: Connect to actual API once POST /attendance endpoint is implemented
// Currently using mock data

function AttendanceDashboard() {
  const [students, setStudents] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TODO: Fetch from API
    // fetch('/api/attendance').then(r => r.json()).then(setAttendance);
    setLoading(false);
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="dashboard">
      <h1>Attendance Dashboard</h1>
      {/* TODO: Add attendance form */}
      {/* TODO: Add attendance table */}
      {/* TODO: Add date filter */}
      <p>Dashboard UI ready — waiting for API integration</p>
    </div>
  );
}

export default AttendanceDashboard;
