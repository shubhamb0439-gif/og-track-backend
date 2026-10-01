const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const logoContainerName = process.env.AZURE_STORAGE_LOGO_CONTAINER || 'branding-logos';

let blobServiceClient = null;
function getBlobServiceClient() {
  if (!connectionString) {
    throw new Error(
      'AZURE_STORAGE_CONNECTION_STRING is not set. Add it to .env (see Azure Blob Storage setup notes).'
    );
  }
  if (!blobServiceClient) {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  }
  return blobServiceClient;
}

/**
 * Uploads a buffer to a blob container and returns its public URL.
 * The container must already exist with "Blob" (anonymous read) public
 * access — this function does not create or configure containers.
 *
 * @param {Buffer} buffer      - file contents (e.g. from multer memoryStorage)
 * @param {string} blobName    - desired blob name, e.g. "logo-169..." (include extension)
 * @param {string} contentType - MIME type, e.g. "image/png"
 * @param {string} [containerName] - defaults to AZURE_STORAGE_LOGO_CONTAINER
 * @returns {Promise<string>} the public blob URL
 */
async function uploadBuffer(buffer, blobName, contentType, containerName = logoContainerName) {
  const containerClient = getBlobServiceClient().getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return blockBlobClient.url;
}

/**
 * Creates `containerName` if it doesn't exist yet, with NO public access
 * (unlike the logo container's anonymous-read setup) — for private,
 * server-only blobs like the coding-agent's node_modules cache, where reads
 * always go through this same authenticated client, never a public URL.
 */
async function ensurePrivateContainer(containerName) {
  const containerClient = getBlobServiceClient().getContainerClient(containerName);
  await containerClient.createIfNotExists();
  return containerClient;
}

/** Downloads a blob as a Buffer, or null if it doesn't exist — for private containers via ensurePrivateContainer. */
async function downloadBuffer(blobName, containerName) {
  const containerClient = getBlobServiceClient().getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  if (!(await blockBlobClient.exists())) return null;
  return blockBlobClient.downloadToBuffer();
}

module.exports = { uploadBuffer, downloadBuffer, ensurePrivateContainer, logoContainerName };
