require("dotenv").config();
const mongoose = require("mongoose");
const ConfigOptionMapping = require("./src/models/configOptionMapping"); // No .model

(async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        console.log("Adding mock mapping rule for TS2S Sweatshirt...");

        // Tạo thử 1 rule map "Sweatshirt" -> "Premium Sweatshirt"
        const existingRule = await ConfigOptionMapping.findOne({
            config_code: "TS2S",
            key: "product type",
            match_value: "Sweatshirt"
        });

        if (!existingRule) {
            await ConfigOptionMapping.create({
                config_code: "TS2S",
                key: "product type",
                match_type: "equals",
                match_value: "Sweatshirt",
                mapped_value: "Premium Sweatshirt",
                case_sensitive: false,
                active: true,
                priority: 1
            });
            console.log("✅ Created mock mapping rule for 'Sweatshirt' -> 'Premium Sweatshirt'");
        } else {
            console.log("Rule already exists, ensuring it is mapped to 'Premium Sweatshirt'...");
            existingRule.mapped_value = "Premium Sweatshirt";
            await existingRule.save();
            console.log("✅ Updated mock mapping rule");
        }

    } catch (err) {
        console.error("❌ Error adding mapping rule:", err);
    } finally {
        await mongoose.disconnect();
    }
})();
