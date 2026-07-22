/**
 * AI candidate screening — ported verbatim (logic-identical) from the original
 * server.js analyzeCandidate(). Scores a candidate 0-100 across skills (40),
 * experience (30), education (15), and JD keyword overlap (15).
 */
function analyzeCandidate(candidate, job) {
  const text = [candidate.coverLetter || candidate.cover_letter || '', candidate.skills || '', candidate.experienceSummary || candidate.experience_summary || '', candidate.education || ''].join(' ').toLowerCase();
  const requiredSkills = Array.isArray(job.skills) ? job.skills : (parseSkills(job.skills)).map(s => s.trim()).filter(Boolean);
  const matchedSkills = requiredSkills.filter(s => text.includes(s.toLowerCase()));
  const missingSkills = requiredSkills.filter(s => !text.includes(s.toLowerCase()));
  const skillScore = requiredSkills.length > 0 ? Math.round((matchedSkills.length / requiredSkills.length) * 40) : 20;

  const reqExpStr = (job.experience || '').replace(/[^\d.]/g, ' ').trim().split(/\s+/)[0];
  const reqExp = parseFloat(reqExpStr) || 0;
  const candExp = parseFloat(candidate.experienceYears || candidate.experience_years) || 0;
  let expScore = 0;
  if (candExp >= reqExp) expScore = 30;
  else if (reqExp > 0 && candExp >= reqExp * 0.7) expScore = 20;
  else if (reqExp > 0 && candExp >= reqExp * 0.5) expScore = 12;
  else if (candExp > 0) expScore = 8;

  const qualReq = (job.qualification || '').toLowerCase();
  let eduScore = 8;
  if (qualReq.includes('phd') || qualReq.includes('doctor')) {
    if (text.includes('phd') || text.includes('doctor')) eduScore = 15;
    else if (text.includes('master') || text.includes('mba')) eduScore = 10;
    else eduScore = 5;
  } else if (qualReq.includes('master') || qualReq.includes('mba')) {
    if (text.includes('master') || text.includes('mba')) eduScore = 15;
    else if (text.includes('bachelor') || text.includes('b.tech') || text.includes('b.e.')) eduScore = 10;
  } else {
    if (text.includes('master') || text.includes('mba') || text.includes('phd')) eduScore = 15;
    else if (text.includes('bachelor') || text.includes('b.tech') || text.includes('b.e.') || text.includes('bsc')) eduScore = 12;
  }

  const jdText = (job.description || '').toLowerCase();
  const jdWords = jdText.split(/\W+/).filter(w => w.length > 4);
  const jdSet = new Set(jdWords);
  const textWords = text.split(/\W+/).filter(w => w.length > 4);
  const jdMatchCount = textWords.filter(w => jdSet.has(w)).length;
  const jdScore = Math.min(15, jdWords.length > 0 ? Math.round((jdMatchCount / jdWords.length) * 100) : 10);

  const totalScore = Math.min(100, skillScore + expScore + eduScore + jdScore);
  let priority = 'Low'; if (totalScore >= 80) priority = 'High'; else if (totalScore >= 60) priority = 'Medium';

  return {
    score: totalScore, skillScore, expScore, eduScore, jdScore,
    matchedSkills, missingSkills,
    experienceMatch: candExp >= reqExp ? 'Meets requirement' : `${candExp}yr (${reqExp}+ required)`,
    priority,
    recommendation: totalScore >= 80 ? 'Strongly recommended' : totalScore >= 60 ? 'Recommended for HR review' : totalScore >= 40 ? 'Consider with screening' : 'Below minimum requirements',
  };
}

// job.skills may be stored as a JSON array string OR a comma-separated string.
function parseSkills(skills) {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills;
  try { const p = JSON.parse(skills); if (Array.isArray(p)) return p; } catch { /* not json */ }
  return String(skills).split(',');
}

module.exports = { analyzeCandidate, parseSkills };
