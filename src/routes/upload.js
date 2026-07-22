const express = require('express');
const multer = require('multer');
const path = require('path');
const { uploadBuffer } = require('../utils/blobStorage');

const router = express.Router();

// Stored in Azure Blob Storage (not local disk — App Service disk is
// ephemeral, so anything written there is lost on restart/scale). multer's
// memoryStorage just buffers the file in RAM briefly before it's streamed up.
// Files are namespaced by tenant slug inside the container (as "slug/name"),
// so tenants can't see each other's uploads even though it's one container.
const TENANT_UPLOAD_CONTAINER = process.env.AZURE_STORAGE_UPLOADS_CONTAINER || 'tenant-uploads';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// POST /api/:slug/upload
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname) || '';
    const blobName = `${req.company.slug}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const url = await uploadBuffer(req.file.buffer, blobName, req.file.mimetype, TENANT_UPLOAD_CONTAINER);
    res.json({ url, name: req.file.originalname, type: req.file.mimetype, size: req.file.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
