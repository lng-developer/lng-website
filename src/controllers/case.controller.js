const db = require('../models');
const Case = db.case;

const getAllCases = async (req, res) => {
    const cases = await Case.find();
    res.json(cases);
};

const getCaseById = async (req, res) => {
    const caseData = await Case.findById(req.params.id);
    if (!caseData) return res.status(404).json({ message: 'Case not found' });
    res.json(caseData);
};

const createCase = async (req, res) => {
    try {
        const payload = req.body;

        let created;

        if (Array.isArray(payload)) {
            created = await Case.insertMany(payload);
        } else {
            created = await Case.create(payload);
        }

        res.status(201).json(created);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};


const updateCase = async (req, res) => {
    const caseData = await Case.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(caseData);
};

const deleteCase = async (req, res) => {
    await Case.findByIdAndDelete(req.params.id);
    res.status(204).send();
};

module.exports = { getAllCases, getCaseById, createCase, updateCase, deleteCase };
