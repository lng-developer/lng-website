const caseService = require("../services/case.service");

class CaseController {
    async getAllCases(req, res) {
        try {
            const cases = await caseService.getAllCases();
            res.json(cases);
        } catch (e) {
            res.status(500).json({ message: e.message });
        }
    }

    async getCaseById(req, res) {
        try {
            const caseData = await caseService.getCaseById(req.params.id);
            res.json(caseData);
        } catch (e) {
            res.status(404).json({ message: e.message });
        }
    }

    async createCase(req, res) {
        try {
            const created = await caseService.createCase(req.body);
            res.status(201).json(created);
        } catch (error) {
            res.status(500).json({ error: { message: error.message } });
        }
    }

    async updateCase(req, res) {
        try {
            const caseData = await caseService.updateCase(req.params.id, req.body);
            res.json(caseData);
        } catch (e) {
            res.status(500).json({ message: e.message });
        }
    }

    async deleteCase(req, res) {
        try {
            await caseService.deleteCase(req.params.id);
            res.status(204).send();
        } catch (e) {
            res.status(500).json({ message: e.message });
        }
    }
}

module.exports = new CaseController();

