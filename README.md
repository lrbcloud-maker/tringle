# Calibration Register

A web app for tracking equipment calibration. Each item gets a QR label, and scanning it on a phone shows that item's details read-only, with no login needed. Logged-in users manage the register; admins manage users, permissions, email and reminders.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. On a brand-new install you create the first admin account.

Windows may ask whether to allow Node.js through the firewall. Allow it on **private networks** so phones on the same network can open scanned QR codes.

Run the automated checks (they use a throwaway database and a fake mail server, so nothing real is touched):

```bash
npm test
```

## Features

**Register**
- Certificate number, owner, department, type, serial number, date of calibration and **calibration period** (in months, 1–120, default 12; quick picks for 6 months to 5 years).
- *Calibration due* is calculated, never typed. It is shown as a month: the calibration month plus the period. The item counts as in date until the **end** of that month. For example, calibrated 20 Dec 2025 with a 24-month period means due Dec 2027, valid until 31 Dec 2027.
- Time left shows in whole months (rounded down) until it's under a month, then in days.
- Calibration report details, all optional: manufacturer, range, calibrated by, procedure / work instruction, temperature, result (*Fit for use* / *Fit for limited use* / *Not fit for use*; "Not fit" turns the item red whatever the dates say), remarks, plus tables of reference instruments, readings and checks performed. These show on the QR scan page too.
- Readings: **Apparatus** (pick from the reference instruments on the form, or type), Specified, Measured, **Error**, calculated automatically as specified − measured to at most 3 decimal places (a size in brackets such as `8mm(7.999mm)` uses the bracketed value, and decimal commas work), and **Adjusted** (Yes / No / N/A).
- Type of equipment, owner, department and manufacturer use a pick-or-add dropdown that shows every saved value. Typing a new value adds it. Admins manage these lists under **Admin → Lists** (add, rename, which also updates every item using it, or remove unused values).
- **Record new calibration** starts a blank calibration and moves the current certificate, with its readings, into the history.
- **Import from Excel** (Register → Import Excel): upload calibration reports (.xlsx). Values are found by their labels (REPORT No., CALIBRATION OF, SERIAL NUMBER, CALIBRATED BY, DATE OF CALIBRATION, instruments table, results table, FUNCTIONS TESTED, FINAL REMARKS…). One file fills in the form for you to check. Several files go to a review table. A serial number already in the register becomes a new calibration for that item, and a report that's already recorded is skipped. Text dates like 02/11/2026 are read day-first (UK).
- Filter the register by every field: owner, department, type, manufacturer, calibrated by, procedure, period, result, certificate / serial / range / remarks text, calibration date range and due-month range. Search covers every field too, and filters carry through to the CSV export.
- Optional contact email (can receive reminders) and private notes.
- Status: *In date*, *Due soon* (configurable, default 30 days), *Overdue*.
- Search, filter by department or status, export to CSV.
- Editing the certificate or date offers to keep the previous certificate in the item's history ("record new calibration").
- Single QR labels (90 × 46 mm), a QR image download, or a sheet of labels for selected items.

**Admin** (top bar → Admin, admins only)
- **Users:** add people by invite link (optionally emailed), set their role, turn reminders on or off, disable, send a password-reset link, or remove. There must always be at least one active admin.
- **Roles & permissions:** choose what *Editors* and *Viewers* can do (view, add/edit, delete, export, see the activity log). *Admin* always has everything.
- **Email (SMTP):** mail server settings with a test-email button. The password is stored encrypted using `data/secret.key`.
- **Reminders:** a daily email listing equipment that has reached a reminder point (default 30, 7 and 1 days before due, plus once when overdue). Sent to users with reminders ticked, extra addresses you add, and optionally each item's contact email (for that item only). Each item is reminded once per point, and catches up if the app was off. Includes a "Send now" button.
- **General:** register name, public site address (used in QR codes and emails), and the "due soon" window.
- **Activity log:** who added, edited, deleted or changed what, and when.

**Everyone:** a light/dark theme switch (top bar, or Your account → Appearance), change your own password, and opt in to reminders.

Logins lock for 15 minutes after 5 wrong passwords.

## Going live

1. Host it somewhere with a **persistent disk**. Free tiers often wipe files, and everything lives in the `data/` folder.
2. Set the public address, either under Admin → General → Site address or with the `BASE_URL` environment variable. **Do this before printing permanent labels**, because QR codes contain the address.
3. Serve it over HTTPS. With `BASE_URL=https://…` set, login cookies are marked secure.
4. Back up the `data/` folder, both `calibration.db` and `secret.key`. Without the key, the saved SMTP password can't be read and has to be typed in again.

Reminder emails are only sent while the app is running.

| Variable      | Purpose                                                                  | Default                    |
|---------------|--------------------------------------------------------------------------|----------------------------|
| `BASE_URL`    | Public address for QR codes and emails (overrides the admin setting)     | admin setting, else this PC |
| `PORT`        | Port to listen on                                                        | `3000`                     |
| `DB_PATH`     | Database file location                                                   | `data/calibration.db`      |
| `SECRET_KEY`  | Key for encrypting the SMTP password (instead of `data/secret.key`)      | key file                   |
| `TRUST_PROXY` | Set to `1` when running behind a reverse proxy                           | off                        |

Requires Node.js 22.13 or newer. Before this version was installed, a backup of the database was saved to `backups/`.
