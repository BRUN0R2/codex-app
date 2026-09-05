pub(super) mod parser;
mod paths;
pub(super) mod plan;
mod text;
pub(super) mod transaction;

const MAX_PATCH_FILES: usize = 256;
const MAX_PATCH_FILE_BYTES: usize = 2 * 1_048_576;
const MAX_PATCH_TOTAL_BYTES: usize = 64 * 1_048_576;

pub(super) const DESCRIPTION: &str = "Edit one or more files in a single transactional patch. Group related edits between one `*** Begin Patch` and `*** End Patch`. Send raw patch text, never JSON. Use workspace-relative paths; missing parent directories are created. Each file starts with `*** Add File: path`, `*** Update File: path`, or `*** Delete File: path`. Add-file lines start with `+`. An update may place `*** Move to: path` before its changes. `@@` opens a change block and never closes one: every block must contain at least one `+` or `-` line. Never emit a trailing or standalone `@@`. Prefix unchanged context with one space and include boundary lines exactly once. An update containing only `+` lines appends at EOF. Include unique surrounding context to insert elsewhere. Combine related file edits in one call; await completion before dependent reads, commands, or further edits.";

#[cfg(test)]
mod batch_tests;
