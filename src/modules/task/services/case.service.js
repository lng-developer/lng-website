const Case = require("../models/case.model");

class CaseService {
    async getAllCases() {
        return await Case.find();
    }

    async getCaseById(id) {
        const caseData = await Case.findById(id);
        if (!caseData) throw new Error("Case not found");
        return caseData;
    }

    async createCase(payload) {
        if (Array.isArray(payload)) {
            return await Case.insertMany(payload);
        } else {
            return await Case.create(payload);
        }
    }

    async updateCase(id, data) {
        return await Case.findByIdAndUpdate(id, data, { new: true });
    }

    async deleteCase(id) {
        return await Case.findByIdAndDelete(id);
    }
}

module.exports = new CaseService();

