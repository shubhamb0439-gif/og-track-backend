/* Run this against CAJO's TENANT database (not OGCore). FK-safe order —
   deletes everything that references inv_items, then inv_items itself.
   NOTE: steps 1-3 also clear CAJO's Sales/Delivery/CRM-PO-line history for
   these items (sale_items.item_id and delivery_items are NOT NULL FKs, so
   they must go before inv_items can be deleted). Delete steps 1-3 if you
   don't want that and instead want to keep items that have sales history
   (they'll then block step 16 with an FK error, which tells you which ones). */

DELETE FROM dbo.delivery_items WHERE sale_item_id IN (SELECT id FROM dbo.sale_items);  -- 1
DELETE FROM dbo.sale_items;                                                            -- 2
DELETE FROM dbo.customer_purchase_order_items;                                         -- 3

DELETE FROM dbo.mfg_assembly_items;                                                    -- 4
DELETE FROM dbo.mfg_assembly_units;                                                    -- 5
DELETE FROM dbo.mfg_assemblies;                                                        -- 6
DELETE FROM dbo.mfg_bom_lines;                                                         -- 7
DELETE FROM dbo.mfg_boms;                                                              -- 8

DELETE FROM dbo.inv_stock_issue_lots;                                                  -- 9
DELETE FROM dbo.inv_stock_issues;                                                      -- 10
DELETE FROM dbo.inv_stock_returns;                                                     -- 11
DELETE FROM dbo.inv_purchase_serial_units;                                             -- 12
DELETE FROM dbo.inv_stock_lots;                                                        -- 13
DELETE FROM dbo.inv_purchase_items;                                                    -- 14
DELETE FROM dbo.inv_purchases;                                                         -- 15
DELETE FROM dbo.inv_stock_adjustments;                                                 -- 16

DELETE FROM dbo.inv_items;                                                             -- 17
