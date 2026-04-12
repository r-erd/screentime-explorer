# Compliance and Legal Information

This document outlines the software licensing, data privacy, and regulatory compliance for the **Screenlog** application.

## 1. Software Licensing

### 1.1 Application License
**Proprietary / All Rights Reserved**
Copyright © 2026. All rights reserved. No part of this application may be reproduced, distributed, or transmitted in any form or by any means without prior written permission.

### 1.2 Third-Party Software
Screenlog utilizes several open-source libraries. These dependencies are used in accordance with their respective licenses (all under the highly permissive **MIT License**).

| Dependency | License | Purpose |
| :--- | :--- | :--- |
| **Electron** | MIT | Application Framework |
| **Better-sqlite3** | MIT | Database Driver (Internal Data Storage) |
| **Chart.js** | MIT | Data Visualization |
| **Electron-builder** | MIT | Packaging and Distribution |
| **@electron/rebuild** | MIT | Native Module Management |

In accordance with the MIT License, the original copyright notices and permission notices for these libraries are included in the application's distribution bundle (typically found within the `LICENSE` files of the `node_modules` directory).

---

## 2. UI Assets and Graphics

### 2.1 System Icons
The icons used within the application's user interface (e.g., `↻`, `‹`, `›`, `ⓘ`, `🔒`) are standard **Unicode characters** rendered by the operating system's default system fonts. These characters do not require separate licensing or attribution.

### 2.2 Custom Brand Assets
The application's primary identity assets are custom-designed for this project:
- **Application Icon**: `assets/icon.png`
- **Menu Bar Template Icon**: `assets/iconTemplate.png`

These assets are considered proprietary to the Screenlog project and are covered under the application's overall proprietary license (See Section 1.1).

---

## 3. Data Privacy & Security

### 2.1 Local-Only Design
Screenlog is built on a **"Privacy by Design"** philosophy. 
- **Zero Telemetry**: No usage data, crash reports, or analytics are sent to any server.
- **Zero Network Access**: The application logic is restricted via a strict Content Security Policy (CSP) and has no internal mechanisms for outbound network requests.
- **Local Storage**: All extracted screen time data is stored exclusively on the user's local machine in a private SQLite database.

### 2.2 Permissions (macOS)
Screenlog requires **Full Disk Access (FDA)** to function.
- **Reason**: macOS protects the system's screen time database (`knowledgeC.db`) behind the Transparency, Consent, and Control (TCC) framework. 
- **Usage**: The application only uses this permission to read the system usage logs. It never modifies system files or accesses unrelated personal documents.

### 2.3 Data Locations
- **Internal Database**: `~/Library/Application Support/Screenlog/screentime.db`
- **System Source**: `~/Library/Application Support/Knowledge/knowledgeC.db`

---

## 3. Regulatory Compliance

### 3.1 GDPR / CCPA
Because Screenlog does not collect, transmit, or process personal data on any remote server, the user maintains **100% ownership and control** over their data. 
- **Right to Access**: Users can directly inspect the local `screentime.db` file using any standard SQLite browser.
- **Right to Erasure**: Deleting the application or its data folder (`~/Library/Application Support/Screenlog/`) permanently removes all historical tracking data.

### 3.2 Security Hardening
The application employs several security features to protect local data:
- **Sandbox**: Enabled for all renderer processes.
- **Context Isolation**: Prevents the frontend from accessing sensitive Node.js APIs.
- **Hardened Runtime**: Enabled for the macOS distribution to prevent code injection.

---

*Disclaimer: This document is for informational purposes and does not constitute legal advice.*
