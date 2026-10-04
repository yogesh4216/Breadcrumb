# AI Attendance System

A simple AI-powered attendance tracking system for educational institutions.

## Features

- Track student attendance with facial recognition
- REST API for managing attendance records
- Dashboard for viewing attendance reports
- Authentication for admin access

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: MongoDB
- **Frontend**: React
- **AI**: TensorFlow.js for facial recognition

## Getting Started

```bash
npm install
npm run dev
```

## API Endpoints

- `POST /api/auth/login` — Login
- `GET /api/students` — List students
- `POST /api/attendance` — Record attendance
- `GET /api/attendance` — Get attendance records
- `GET /api/reports` — Get attendance reports

## TODO

- [ ] Create attendance model
- [ ] Implement POST /attendance endpoint
- [ ] Implement GET /attendance endpoint
- [ ] Connect frontend to API
- [ ] Add unit tests
- [ ] Set up facial recognition
