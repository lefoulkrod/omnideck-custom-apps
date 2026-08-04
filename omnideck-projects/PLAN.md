# Plan: Enhanced Files & Folders View — COMPLETED

## What was done

### Backend (app.py)
- **Modified `browse_files`**: Added `sort` (name/size/modified/type) and `filter` (all/files/folders) params. Returns `total_size` of visible files.
- **Added `preview_file`**: Returns text content (first 50KB), image URL, or hex dump (first 256 bytes) for binary files. Includes content type, size, modified date, line count.
- **Added `delete_file`**: Deletes a file or folder (shutil.rmtree for dirs). Rejects root directory and paths outside FILES_ROOT.
- **Added `rename_file`**: Renames in place (same parent). Validates name (no path separators, no control chars, max 255 chars, no duplicates).
- **Added `get_file_info`**: Returns detailed metadata (size, modified, created, content_type, is_text, line_count for text files, file_count for dirs).

### Frontend (main.js, app.css, index.html)
- **Sort dropdown**: Name A→Z, Largest first, Newest first, By extension
- **Filter dropdown**: Files & folders, Files only, Folders only
- **File-specific icons**: Different Bootstrap Icons per file extension (py, js, json, md, pdf, images, etc.)
- **Preview button** (eye icon): Opens inline preview panel showing text content, image, or hex dump
- **Download button** (download icon): Native browser download via `<a download>`
- **Rename button** (pencil icon): Prompt for new name
- **Delete button** (trash icon): Confirmation modal with warning, then deletes
- **Preview panel**: Shows file name, path, content type, size, modified date. Has download/rename/delete actions. Text shown in monospace pre. Images shown inline. Binary shows hex dump.
- **Confirmation modal**: Updated to support dynamic callout text and button label
- **Total size display**: Shows total size of visible files in toolbar

### Tests (test_app.py)
- 13 new tests covering: browse_files sort/filter, preview_file (text/binary/image/directory/escape), delete_file (file/folder/root/escape), rename_file (success/duplicate/separator/empty), get_file_info (file/folder/escape)
- Updated action registry test with 4 new action names
- All 33 tests pass