-- One-time cleanup: approved applications whose dealer was already deleted
-- (left behind by the old delete). Step 1 only LOOKS. Step 2 deletes.

-- Step 1: preview what would be removed
SELECT a.id, a.business_name, a.email, a.status, a.created_at
FROM public.dealer_applications a
WHERE a.status = 'approved'
  AND NOT EXISTS (SELECT 1 FROM public.dealers d WHERE d.id = a.linked_dealer_id)
  AND NOT EXISTS (SELECT 1 FROM public.dealers d WHERE LOWER(d.email) = LOWER(a.email));

-- Step 2: after checking the list above is only deleted dealers, run this
DELETE FROM public.dealer_applications a
WHERE a.status = 'approved'
  AND NOT EXISTS (SELECT 1 FROM public.dealers d WHERE d.id = a.linked_dealer_id)
  AND NOT EXISTS (SELECT 1 FROM public.dealers d WHERE LOWER(d.email) = LOWER(a.email));
