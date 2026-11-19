"""Insert the consistent public demonstration baseline without resetting later edits."""

from datetime import datetime, timedelta, timezone
from pymongo.asynchronous.database import AsyncDatabase
from app.core.security import hash_password

DEMO_PASSWORD = "PortalDemo123!"
ROLE_PERMISSIONS = {
    "Administrator": ["view", "create", "edit", "delete", "export", "administer"],
    "Executive": ["view", "export"], "Portfolio Leader": ["view", "create", "edit", "export"],
    "Engineer": ["view", "create", "edit", "export"], "Auditor": ["view", "export"], "Read Only": ["view"],
}
ROLE_DESCRIPTIONS = {
    "Administrator": "Manage accounts, role permissions, inventory, and sensitive history.",
    "Executive": "Inspect enterprise quality and export permitted inventory reports.",
    "Portfolio Leader": "Maintain explicitly assigned portfolios and their applications.",
    "Engineer": "Maintain applications within assigned portfolio access.",
    "Auditor": "Inspect inventory and audit history without modifying records.",
    "Read Only": "Inspect permitted inventory and reports without mutation or export.",
}
DEMO_ACCOUNTS = [
    ("Administrator", "admin", "Alex Morgan", "Jordan Ellis", False),
    ("Executive", "executive", "Taylor Reed", "Jordan Ellis", False),
    ("Portfolio Leader", "leader", "Casey Rivera", "Taylor Reed", False),
    ("Engineer", "engineer", "Sam Chen", "Casey Rivera", True),
    ("Auditor", "auditor", "Robin Patel", "Jordan Ellis", False),
    ("Read Only", "readonly", "Jamie Brooks", "Taylor Reed", False),
]
PORTFOLIOS = [
    ("Payments", "Casey Rivera", "Commerce", "Secure payment processing and settlement."),
    ("Customer Platform", "Avery Quinn", "Customer", "Customer identity and service experiences."),
    ("Data & Analytics", "Drew Lane", "Data", "Enterprise data products and insight delivery."),
]
APPLICATIONS = [
    ("Payment Gateway", 0, "Critical", 1, "Active", "High", 72, 76, 64, 82, 18, 3, "Python / FastAPI"),
    ("Settlement Engine", 0, "High", 2, "Active", "Medium", 85, 81, 70, 88, 9, 1, "Java / Spring"),
    ("Fraud Signals", 0, "Critical", 1, "Active", "High", 61, 68, 55, 72, 22, 4, "Python / Kafka"),
    ("Legacy Billing", 0, "Medium", 3, "Deprecated", "Medium", 58, 62, 35, 45, 14, 0, "Java / Oracle"),
    ("Customer Identity", 1, "High", 1, "Active", "Low", 93, 90, 86, 94, 4, 0, "TypeScript / Node"),
    ("Service Console", 1, "Medium", 2, "Active", "Low", 88, 85, 78, 83, 6, 0, "React / FastAPI"),
    ("Contact Archive", 1, "Low", 4, "Retired", "Low", 76, 74, 42, 60, 2, 0, "Java / PostgreSQL"),
    ("Analytics Warehouse", 2, "High", 2, "Active", "Medium", 82, 79, 73, 81, 11, 1, "Python / Spark"),
    ("Insights Portal", 2, "Medium", 3, "Active", "Low", 91, 87, 84, 90, 5, 0, "React / TypeScript"),
    ("Batch Data Loader", 2, "Low", 4, "Deprecated", "High", 54, 59, 31, 48, 17, 2, "Python / Airflow"),
]


async def seed_database(db: AsyncDatabase) -> None:
    """Upsert natural keys and baseline history with insert-only values."""
    now = datetime.now(timezone.utc)
    for name, permissions in ROLE_PERMISSIONS.items():
        await db.roles.update_one({"name": name}, {"$setOnInsert": {"name": name,
            "description": ROLE_DESCRIPTIONS[name], "permissions": permissions}}, upsert=True)
    portfolio_ids = []
    for name, owner, area, description in PORTFOLIOS:
        await db.portfolios.update_one({"name": name}, {"$setOnInsert": {"name": name, "owner": owner,
            "productArea": area, "description": description, "status": "Active"}}, upsert=True)
        portfolio_ids.append((await db.portfolios.find_one({"name": name}))["_id"])
    for role_name, local, name, manager, vendor in DEMO_ACCOUNTS:
        role = await db.roles.find_one({"name": role_name})
        email = f"{local}@portfolio.local"
        access = portfolio_ids[:2] if role_name == "Portfolio Leader" else portfolio_ids[:1] if role_name == "Engineer" else []
        existing = await db.users.find_one({"email": email})
        if not existing:
            await db.users.update_one({"email": email}, {"$setOnInsert": {"email": email, "name": name,
                "roleId": role["_id"], "portfolioAccess": access, "status": "Active", "managerName": manager,
                "vendor": vendor, "passwordHash": await hash_password(DEMO_PASSWORD), "authVersion": 0,
                "mustChangePassword": role_name == "Administrator",
                "defaultLanding": "Dashboard" if role_name in ("Administrator", "Executive") else "Applications",
                "lastSignIn": now - timedelta(days=1)}}, upsert=True)
        user = await db.users.find_one({"email": email})
        await db.audit.update_one({"seedKey": f"signin-{local}"}, {"$setOnInsert": {
            "seedKey": f"signin-{local}", "time": now - timedelta(days=1), "personId": user["_id"],
            "person": name, "action": "sign-in success", "entityType": "user", "entityId": user["_id"],
            "summary": "Prior demonstration sign-in."}}, upsert=True)
    for index, row in enumerate(APPLICATIONS):
        name, portfolio, criticality, tier, lifecycle, risk, health, quality, automation, unit, defects, critical, stack = row
        owner = PORTFOLIOS[portfolio][1]
        await db.applications.update_one({"name": name}, {"$setOnInsert": {"name": name,
            "description": f"Supports {name.lower()} operations and governed enterprise delivery.",
            "portfolioId": portfolio_ids[portfolio], "productArea": PORTFOLIOS[portfolio][2],
            "businessOwner": owner, "technologyOwner": "Sam Chen", "qualityOwner": "Jamie Brooks",
            "criticality": criticality, "tier": tier, "lifecycle": lifecycle, "risk": risk,
            "healthScore": health, "qualityScore": quality, "automationCoverage": automation,
            "unitTestCoverage": unit, "openDefects": defects, "openCriticalDefects": critical,
            "technologyStack": stack, "repositoryLink": f"https://example.com/repos/app-{index + 1}" if index < 6 else "",
            "pipelineLink": f"https://example.com/pipelines/app-{index + 1}" if index < 6 else ""}}, upsert=True)
