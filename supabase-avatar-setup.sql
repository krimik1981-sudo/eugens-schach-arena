-- Run once in Supabase SQL Editor for Eugens Schach Arena
-- Images stay in a private bucket; server endpoints authenticate uploads.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('arena-avatars', 'arena-avatars', false, 350000, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
SET public=false, file_size_limit=350000, allowed_mime_types=ARRAY['image/jpeg'];
