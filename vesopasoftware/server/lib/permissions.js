/* What a person on the customer side is allowed to do.
 *
 * One table, read by both the routes and the templates, so a button is never
 * shown for something the route will then refuse. A Vesopa admin bypasses all
 * of it — `role === 'admin'` is checked before this map is ever consulted.
 */

export const ORG_ROLES = [
  { id: "owner",   label: "Owner",   blurb: "Everything, including billing and adding people." },
  { id: "manager", label: "Manager", blurb: "Projects, briefs and messages. No access to invoices." },
  { id: "billing", label: "Billing", blurb: "Invoices, payments and messages. Cannot change projects." },
  { id: "member",  label: "Member",  blurb: "Projects and conversations. No billing, no team changes." },
  { id: "viewer",  label: "Viewer",  blurb: "Read-only. Can see progress, can change nothing." },
];

const CAPABILITIES = {
  owner:   ["project.view", "project.create", "project.edit", "message.send",
            "billing.view", "billing.pay", "team.view", "team.manage", "org.edit"],
  manager: ["project.view", "project.create", "project.edit", "message.send", "team.view"],
  billing: ["project.view", "message.send", "billing.view", "billing.pay", "team.view"],
  member:  ["project.view", "message.send", "team.view"],
  viewer:  ["project.view", "team.view"],
};

export function can(user, capability) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return (CAPABILITIES[user.org_role] || []).includes(capability);
}

/** Guard factory for routes. Renders the same refusal page the nav avoids. */
export function requireCap(capability) {
  return (req, res, next) => {
    if (can(req.user, capability)) return next();
    res.status(403).render("error", {
      title: "Not your permission",
      message:
        "Your account does not have access to that. Ask whoever owns your " +
        "organisation's account to change your role.",
      back: "/portal",
    });
  };
}

export const roleLabel = (id) => ORG_ROLES.find((r) => r.id === id)?.label || id;
