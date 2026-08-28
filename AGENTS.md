# Repository contract

Read `docs/RULES.md` completely before changing code; it is authoritative.

Fix root causes. Do not ship workarounds, silent fallbacks, temporary patches,
compatibility shims, or gambiarras. Keep changes minimal, native, strongly typed,
explicit, modular, and predictable.

Add focused regression coverage for every corrected defect, keep `docs/TODO.md`
accurate, and run the affected tests plus `pnpm verify` before completion.
