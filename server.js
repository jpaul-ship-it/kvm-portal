# Phase 1A — Deploy & Verification Checklist

## What Phase 1A Contains

**Data model (new):**
- `skills` table — seeded with 18 skills in 6 categories
- `trucks` table — empty, you'll populate via admin UI
- `vendors`, `bills`, `bill_lines`, `chart_of_accounts` tables — empty, structure only (no UI yet)

**Columns added to existing tables (via ALTER TABLE, try/catch safe):**
- `users`: `skills`, `labor_rate_burdened`, `labor_rate_updated_at`, `labor_rate_updated_by_user_id`, `sales_department`
- `projects`: `work_types`, `required_skills`, `revenue_department`

**New API endpoints:**
- `/api/skills` CRUD (admin)
- `/api/trucks` CRUD (manager+)
- `/api/chart-of-accounts` CRUD (admin)
- `/api/gl-defaults` GET/PUT
- `/api/users/:id/extended`, `/skills`, `/labor-rate`, `/sales-dept`
- `/api/projects/:id/work-meta`
- `/api/worktypes`, `/api/billcategories`, `/api/skillcategories`, `/api/revenuedepts`
- `/api/admin/db-backup` — one-click DB download

**UI additions:**
- Settings page reorganized into sub-tabs: General / Skills / Trucks / GL Defaults / Chart of Accounts / Backup
- Employee edit modal: Skills section (with Check All), Burdened Labor Rate, Sales Department
- Project modal: Revenue Department, Work Types, Required Skills (with Check All)
- New modals: Skill, Truck, Chart of Accounts (add/edit), CoA Upload (parses IIF or CSV)

## 🔒 BEFORE DEPLOYING — BACKUP YOUR DB

**You're on Render Starter with persistent disk, so your data will survive, but back up anyway:**

Render Dashboard → kvm-portal service → Shell tab → run:
```
cat /data/kvm.db > /tmp/kvm-backup.db
ls -la /tmp/kvm-backup.db
```

If that looks good, you have a snapshot. If anything goes wrong during deploy, you can restore from it.

*Alternatively, after Phase 1A deploys successfully, you can use the new "Download kvm.db" button in Settings → Backup to grab future backups.*

## Deploy Steps

1. **Open your GitHub repo** (https://github.com/jpaul-ship-it/kvm-portal) in a browser tab.
2. **Replace each of the three files** — one at a time, commit between each if you want granular rollback:
   - `server.js` (root) ← from outputs
   - `public/index.html` ← from outputs
   - `public/js/app.js` ← from outputs
3. **Watch Render Deploy Logs.** Look for:
   - No syntax errors
   - Line: `✓ Phase 1A: Seeded 18 skills` (only appears first time if skills table is empty)
   - Line: `Running on http://localhost:3000` (final success line)
4. **Open the portal.** Login should work with your existing admin credentials.

## ✅ Verification Checklist (run through top-to-bottom after deploy)

### Smoke test — make sure nothing broke
- [ ] Portal loads at kvm-portal.onrender.com
- [ ] Login works with your admin creds
- [ ] Dashboard renders normally
- [ ] Existing features still work: Timeclock, PTO, Customers, Quotes, Projects

### Settings sub-tabs
- [ ] Click Portal Settings nav — new sub-tabs appear at top: **General | Skills | Trucks / Crews | GL Defaults | Chart of Accounts | Backup**
- [ ] General tab shows existing SMTP, PO format, QB import, daily emails cards (nothing lost)
- [ ] Click each sub-tab — content loads without errors

### Skills tab
- [ ] 18 seeded skills display, grouped by 6 categories
- [ ] Click "+ Add Skill" — modal opens
- [ ] Add a test skill (e.g., key: `test_skill`, label: `Test Skill`, category: Dock Equipment)
- [ ] Save — skill appears in the list
- [ ] Edit that test skill — change label — save — label updates
- [ ] Remove the test skill — it disappears from the list

### Trucks tab
- [ ] Empty state shows "No trucks/crews defined yet."
- [ ] Click "+ Add Truck" — modal opens with Row Type dropdown
- [ ] Select Row Type "Truck / Crew" — Lead Technician dropdown appears populated with employees
- [ ] Pick a lead, set sort order 10, save — truck appears in list with lead's name
- [ ] Change Row Type to "Shop" in the add modal — lead dropdown hides
- [ ] Change Row Type to "Temp Crew" — date fields appear
- [ ] Edit an existing truck — values prefill correctly
- [ ] Add all 13 trucks if you want, matching your Excel order

### GL Defaults tab
- [ ] 7 input fields appear (Material, Freight, Tax, Equipment, Subs, Travel/Lodging, Other)
- [ ] Type anything in one field, click Save — see success toast
- [ ] Refresh page — value persists

### Chart of Accounts tab
- [ ] Empty state shows "No accounts yet."
- [ ] Click "+ Add Account" — modal opens, save an account manually
- [ ] Account appears in list
- [ ] Click "Upload from QB (CSV/IIF)" — upload modal opens
- [ ] (Optional) Paste your CoA when you have it, run import

### Backup tab
- [ ] "Download kvm.db" button present
- [ ] Click it — browser should download a file named `kvm-db-backup.db`

### Employee skills/labor/sales dept
- [ ] Manage Employees → Edit any employee
- [ ] Below the existing Hire Date row, a new "SKILLS & PAY" section appears
- [ ] Labor Rate input, Sales Department dropdown, Skills checkbox grid (with 18 skills in 6 groups)
- [ ] "Check all skills" master toggle works
- [ ] Per-category "Check category" toggles work
- [ ] Set labor rate to 45.50, select 3 skills, set sales department to New Construction, save
- [ ] Reopen the same employee — labor rate, sales dept, and 3 skills are all still checked
- [ ] Labor rate meta-text shows "Last updated [today] by [you]"

### Project work types / required skills / revenue dept
- [ ] Go to Projects → open any existing project → click Edit (or create a new test project)
- [ ] Bottom of modal has new "Classification" section with Revenue Department dropdown, Work Types checkboxes (7), Required Skills checkboxes (18 in 6 groups)
- [ ] Check 2 work types + 3 required skills + set revenue department to Aftermarket, save
- [ ] Reopen the project for edit — selections persist

### Regressions check
- [ ] Existing project Job Costing tab still works (nothing changed there in Phase 1A)
- [ ] Creating a quote still works
- [ ] Timeclock in/out still works
- [ ] PTO request still works
- [ ] Add Employee still works (new fields don't interfere)

## If Something Goes Wrong

**If login breaks or the server won't boot:**
Look at Render logs first. If it's a `SyntaxError` in a file you replaced, that file got corrupted during upload (line breaks, encoding, or copy-paste truncation). Restore that one file from the uploaded backups I worked from.

**If the DB is corrupted:**
Restore from `/tmp/kvm-backup.db` you made before deploy:
```
cp /tmp/kvm-backup.db /data/kvm.db
```

**If a specific Phase 1A feature misbehaves but existing features work:**
Report the exact error message + what you clicked and I'll fix in the next session. Don't revert the whole deploy for a minor Phase 1A issue — the foundations are valuable even with a small bug.

## What's NOT in Phase 1A (next phases)

- No bill entry UI (tables exist, but no way to enter bills yet)
- No QuickBooks export for bills
- No changes to existing Job Costing tab (still uses old `project_costs` table untouched)
- No schedule grid, side panels, service jobs, leads, sales dashboard
- Nothing visible to non-manager users except Skills section on their own profile (managers can see it, techs cannot edit their own rate)

## Next Session

Once Phase 1A is deployed and verified:
1. Report any issues found
2. Go add your 13 trucks via Settings → Trucks
3. Start tagging your key people with skills
4. Consider uploading your QB Chart of Accounts when you have the export handy

Then we move to **Phase 1.5 (Opportunities/Leads module)** or whichever phase you want next.
