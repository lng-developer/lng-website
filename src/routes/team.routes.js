const express = require("express");
const teamController = require("../controllers/team.controller")
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");

const router = express.Router();

router.post(
    "/",
    authenticateToken,
    authorizeRoles("Admin"),
    teamController.createTeam
)

router.put(
    "/:teamId",
    authenticateToken,
    authorizeRoles("Admin"),
    teamController.updateTeam
)

router.get(
    "/",
    authenticateToken,
    authorizeRoles("Admin", "Seller"),
    teamController.getTeams
);

router.get(
    "/:teamId",
    authenticateToken,
    authorizeRoles("Admin"),
    teamController.getTeamMembers
);

router.delete(
    "/:teamId",
    authenticateToken,
    authorizeRoles("Admin"),
    teamController.deleteTeam
)

//members
router.post(
    "/:teamId/members",
    authenticateToken,
    authorizeRoles("Admin"),
    teamController.addMembers
);

router.post(
    "/:teamId/members/remove",
    authenticateToken,
    authorizeRoles("Admin"),
    teamController.removeMembers
)

module.exports = router;