const express = require('express');
const { nextCounter } = require('../utils/counters');
const { analyzeCandidate } = require('../utils/hrScoring');
const router = express.Router();

const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
function safeJson(v) { try { return JSON.parse(v); } catch { return v; } }

// ── Row mappers ───────────────────────────────────────────────────────────────

// Frontend reads: id, jobId, title, department, employmentType, location, workMode,
//   experience, vacancies, description, salaryRange, qualification, skills[], status,
//   applications, createdAt
const mapJob = (r) => r && ({
  id: r.id,
  jobId: r.job_id,
  title: r.title,
  department: r.department,
  employmentType: r.employment_type,
  location: r.location,
  workMode: r.work_mode,
  experience: r.experience,
  vacancies: r.vacancies,
  description: r.description,
  salaryRange: r.salary_range,
  qualification: r.qualification,
  skills: r.skills ? safeJson(r.skills) : [],
  status: r.status,
  applications: r.applications || 0,
  extra: r.extra_json ? JSON.parse(r.extra_json) : {},
});

// Frontend reads: id, candidateId, jobId, name, email, phone, resumeUrl, coverLetter,
//   skills, experienceSummary, education, experienceYears, status, aiScore, aiAnalysis{},
//   statusHistory[], appliedAt
const mapCandidate = (r) => r && ({
  id: r.id,
  candidateId: r.candidate_id,
  jobId: r.job_id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  resumeUrl: r.resume_url,
  coverLetter: r.cover_letter,
  skills: r.skills ? safeJson(r.skills) : null,
  experienceSummary: r.experience_summary,
  education: r.education,
  experienceYears: r.experience_years,
  status: r.status,
  aiScore: r.ai_score,
  aiAnalysis: r.ai_analysis ? JSON.parse(r.ai_analysis) : null,
  statusHistory: JSON.parse(r.status_history || '[]'),
  appliedAt: dTime(r.applied_at),
  extra: r.extra_json ? JSON.parse(r.extra_json) : {},
});

// Frontend reads: id, interviewId, candidateId, jobId, scheduledAt, interviewer, mode,
//   status, feedback
const mapInterview = (r) => r && ({
  id: r.id,
  interviewId: r.interview_id,
  candidateId: r.candidate_id,
  jobId: r.job_id,
  scheduledAt: dTime(r.scheduled_at),
  interviewer: r.interviewer,
  mode: r.mode,
  status: r.status,
  feedback: r.feedback,
});

// ── JOBS ──────────────────────────────────────────────────────────────────────
router.get('/jobs', async (req, res) => {
  try { res.json((await req.db('jobs').orderBy('created_at', 'desc')).map(mapJob)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/jobs/public', async (req, res) => {
  try { res.json((await req.db('jobs').where({ status: 'published' })).map(mapJob)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/jobs', async (req, res) => {
  try {
    const num = await nextCounter(req.db, 'job_counter');
    const jobId = 'JOB-' + String(num).padStart(3, '0');
    const id = 'job' + Date.now();
    const b = req.body;
    await req.db('jobs').insert({
      id, job_id: jobId, title: b.title, department: b.department || null,
      employment_type: b.employmentType || b.employment_type || null,
      location: b.location || null, work_mode: b.workMode || b.work_mode || null,
      experience: b.experience || null, vacancies: b.vacancies || 1,
      description: b.description || null, salary_range: b.salaryRange || b.salary_range || null,
      qualification: b.qualification || null,
      skills: b.skills ? JSON.stringify(Array.isArray(b.skills) ? b.skills : String(b.skills).split(',').map(s => s.trim())) : null,
      status: b.status || 'draft', applications: 0,
    });
    res.json(mapJob(await req.db('jobs').where({ id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/jobs/:id', async (req, res) => {
  try {
    const b = req.body;
    const upd = { updated_at: new Date() };
    if (b.title !== undefined) upd.title = b.title;
    if (b.department !== undefined) upd.department = b.department;
    if (b.employmentType !== undefined || b.employment_type !== undefined) upd.employment_type = b.employmentType || b.employment_type;
    if (b.location !== undefined) upd.location = b.location;
    if (b.workMode !== undefined || b.work_mode !== undefined) upd.work_mode = b.workMode || b.work_mode;
    if (b.experience !== undefined) upd.experience = b.experience;
    if (b.vacancies !== undefined) upd.vacancies = b.vacancies;
    if (b.description !== undefined) upd.description = b.description;
    if (b.salaryRange !== undefined || b.salary_range !== undefined) upd.salary_range = b.salaryRange || b.salary_range;
    if (b.qualification !== undefined) upd.qualification = b.qualification;
    if (b.status !== undefined) upd.status = b.status;
    if (b.skills !== undefined) upd.skills = JSON.stringify(Array.isArray(b.skills) ? b.skills : String(b.skills).split(',').map(s => s.trim()));
    await req.db('jobs').where({ id: req.params.id }).update(upd);
    res.json(mapJob(await req.db('jobs').where({ id: req.params.id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/jobs/:id', async (req, res) => {
  try { await req.db('jobs').where({ id: req.params.id }).delete(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CANDIDATES ────────────────────────────────────────────────────────────────
router.get('/candidates', async (req, res) => {
  try {
    let q = req.db('candidates').orderBy('applied_at', 'desc');
    if (req.query.jobId) q = q.where('job_id', req.query.jobId);
    res.json((await q).map(mapCandidate));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/candidates/:id', async (req, res) => {
  try {
    const row = await req.db('candidates').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(mapCandidate(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/candidates', async (req, res) => {
  try {
    const num = await nextCounter(req.db, 'candidate_counter');
    const candidateId = 'CAND-' + String(num).padStart(4, '0');
    const id = 'cand' + Date.now();
    const now = new Date();
    const b = req.body;
    const known = {
      id, candidate_id: candidateId, job_id: b.jobId || b.job_id || null,
      name: b.name || null, email: b.email || null, phone: b.phone || null,
      resume_url: b.resumeUrl || b.resume_url || null,
      cover_letter: b.coverLetter || b.cover_letter || null,
      skills: typeof b.skills === 'string' ? b.skills : (b.skills ? JSON.stringify(b.skills) : null),
      experience_summary: b.experienceSummary || b.experience_summary || null,
      education: b.education || null,
      experience_years: b.experienceYears || b.experience_years || null,
      status: 'applied', ai_score: null, ai_analysis: null,
      status_history: JSON.stringify([{ status: 'applied', timestamp: now.toISOString(), by: 'Candidate' }]),
      applied_at: now,
    };
    await req.db('candidates').insert(known);
    if (known.job_id) {
      const job = await req.db('jobs').where({ id: known.job_id }).first();
      if (job) {
        await req.db('jobs').where({ id: known.job_id }).increment('applications', 1);
        try {
          const analysis = analyzeCandidate({ ...b, cover_letter: known.cover_letter, experience_years: known.experience_years }, { ...job, skills: job.skills ? safeJson(job.skills) : [] });
          const newStatus = analysis.score >= 60 ? 'shortlisted' : 'ai_screened';
          const hist = JSON.parse(known.status_history);
          hist.push({ status: 'ai_screened', timestamp: new Date().toISOString(), by: 'AI System' });
          await req.db('candidates').where({ id }).update({ ai_score: analysis.score, ai_analysis: JSON.stringify(analysis), status: newStatus, status_history: JSON.stringify(hist) });
        } catch (_) {}
      }
    }
    res.json(mapCandidate(await req.db('candidates').where({ id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/candidates/:id', async (req, res) => {
  try {
    const current = await req.db('candidates').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    const upd = { updated_at: new Date() };
    if (b.status !== undefined && b.status !== current.status) {
      const hist = JSON.parse(current.status_history || '[]');
      hist.push({ status: b.status, timestamp: new Date().toISOString(), by: b.changedBy || 'HR' });
      upd.status = b.status;
      upd.status_history = JSON.stringify(hist);
    }
    if (b.resumeUrl !== undefined) upd.resume_url = b.resumeUrl;
    if (b.coverLetter !== undefined) upd.cover_letter = b.coverLetter;
    if (b.experienceSummary !== undefined) upd.experience_summary = b.experienceSummary;
    if (b.experienceYears !== undefined) upd.experience_years = b.experienceYears;
    if (b.name !== undefined) upd.name = b.name;
    if (b.email !== undefined) upd.email = b.email;
    if (b.phone !== undefined) upd.phone = b.phone;
    await req.db('candidates').where({ id: req.params.id }).update(upd);
    res.json(mapCandidate(await req.db('candidates').where({ id: req.params.id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/candidates/:id', async (req, res) => {
  try { await req.db('candidates').where({ id: req.params.id }).delete(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/candidates/:id/analyze', async (req, res) => {
  try {
    const candidate = await req.db('candidates').where({ id: req.params.id }).first();
    if (!candidate) return res.status(404).json({ error: 'Not found' });
    const job = await req.db('jobs').where({ id: candidate.job_id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const analysis = analyzeCandidate({ ...candidate, cover_letter: candidate.cover_letter, experience_years: candidate.experience_years }, { ...job, skills: job.skills ? safeJson(job.skills) : [] });
    await req.db('candidates').where({ id: req.params.id }).update({ ai_score: analysis.score, ai_analysis: JSON.stringify(analysis) });
    res.json({ id: req.params.id, aiScore: analysis.score, aiAnalysis: analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INTERVIEWS ────────────────────────────────────────────────────────────────
router.get('/interviews', async (req, res) => {
  try {
    let q = req.db('interviews').orderBy('scheduled_at', 'desc');
    if (req.query.candidateId) q = q.where('candidate_id', req.query.candidateId);
    res.json((await q).map(mapInterview));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/interviews', async (req, res) => {
  try {
    const num = await nextCounter(req.db, 'interview_counter');
    const interviewId = 'INT-' + String(num).padStart(4, '0');
    const id = 'int' + Date.now();
    const b = req.body;
    await req.db('interviews').insert({
      id, interview_id: interviewId,
      candidate_id: b.candidateId || b.candidate_id,
      job_id: b.jobId || b.job_id || null,
      scheduled_at: b.scheduledAt || b.scheduled_at || null,
      interviewer: b.interviewer || null, mode: b.mode || null,
      status: 'scheduled', feedback: b.feedback || null,
    });
    if (b.candidateId || b.candidate_id) {
      const candId = b.candidateId || b.candidate_id;
      const cand = await req.db('candidates').where({ id: candId }).first();
      if (cand) {
        const hist = JSON.parse(cand.status_history || '[]');
        hist.push({ status: 'interview_scheduled', timestamp: new Date().toISOString(), by: b.scheduledBy || 'HR' });
        await req.db('candidates').where({ id: candId }).update({ status: 'interview_scheduled', status_history: JSON.stringify(hist) });
      }
    }
    res.json(mapInterview(await req.db('interviews').where({ id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/interviews/:id', async (req, res) => {
  try {
    const b = req.body;
    const upd = { updated_at: new Date() };
    if (b.scheduledAt !== undefined) upd.scheduled_at = b.scheduledAt;
    if (b.interviewer !== undefined) upd.interviewer = b.interviewer;
    if (b.mode !== undefined) upd.mode = b.mode;
    if (b.status !== undefined) upd.status = b.status;
    if (b.feedback !== undefined) upd.feedback = b.feedback;
    await req.db('interviews').where({ id: req.params.id }).update(upd);
    res.json(mapInterview(await req.db('interviews').where({ id: req.params.id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/interviews/:id', async (req, res) => {
  try { await req.db('interviews').where({ id: req.params.id }).delete(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;