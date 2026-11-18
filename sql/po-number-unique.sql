/* =============================================================================
   PO Number uniqueness — SQL steps for senior review
   =============================================================================
   Per the agreed process: nothing here is run automatically. Each step below
   is numbered, explained, and marked read-only or data/schema-changing.
   Run in order, in this file's own tenant database (one per company — see
   "Scoping" note below). Steps 2+ are added here only after Step 1's results
   come back and get approved.
   ========================================================================== */

/* -----------------------------------------------------------------------
   SQL Step 1 — find existing duplicate PO numbers (READ-ONLY, changes nothing)
   -----------------------------------------------------------------------
   What it does: lists any PO number that appears more than once in this
   tenant's dbo.inv_purchases table, after normalizing (trim whitespace,
   lowercase) so "PO00022", "po00022" and " PO00022 " are correctly counted
   as the same value — but NOT treating "PO00022" and "PO-00020" as the same
   (different value entirely; hyphenation is left as a separate question,
   see the note below). Blank/NULL PO numbers are excluded on purpose — an
   empty PO number is allowed to repeat any number of times, by design.
   ----------------------------------------------------------------------- */
SELECT
    LTRIM(RTRIM(LOWER(po_number))) AS normalized_po_number,
    COUNT(*) AS duplicate_count,
    STRING_AGG(CAST(id AS NVARCHAR(MAX)) + ':' + po_number, ' | ') AS matching_rows
FROM dbo.inv_purchases
WHERE po_number IS NOT NULL AND LTRIM(RTRIM(po_number)) <> ''
GROUP BY LTRIM(RTRIM(LOWER(po_number)))
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

/* -----------------------------------------------------------------------
   SQL Step 2 — add the unique constraint (SCHEMA-CHANGING — pending Step 1's
   results + an explicit decision on hyphenation; not run yet)
   -----------------------------------------------------------------------
   Will be filled in and added to the real tenant-schema patch file
   (ogtrack-sql-schema/tenant/patch_28_inv_purchases_po_number_unique.sql)
   once Step 1 comes back clean (or any existing duplicates are resolved) and
   the hyphenation question below is answered. Not written yet — intentionally
   left blank until that happens, so nothing here gets run ahead of approval.
   ----------------------------------------------------------------------- */
