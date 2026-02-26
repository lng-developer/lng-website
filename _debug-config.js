require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    // Thử xem collection 'productforsellers' CÓ THẬT SỰ TỒN TẠI KHÔNG NHƯNG BỊ LỖI CHỮ HOA/THƯỜNG?
    const collections = await mongoose.connection.db.listCollections().toArray();
    const cnames = collections.map(c => c.name.toLowerCase());
    console.log("Collections containing 'seller':", cnames.filter(n => n.includes("seller")));

    // Lấy 1 config TS2S
    const cfg = await mongoose.connection.collection("configcostcenters")
        .findOne({ config_code: "TS2S" });

    console.log("Config TS2S product_for_seller:", cfg.product_for_seller);

    // Thử find trong producttypegroups
    const ptg = await mongoose.connection.collection("producttypegroups")
        .findOne({ _id: cfg.product_for_seller });
    console.log("Is product_for_seller in producttypegroups?", !!ptg, ptg?.name);

    // Thử find trong collection khác?
    for (const cname of collections.map(c => c.name)) {
        if (cname === "configcostcenters" || cname === "producttypegroups" || cname.includes("log") || cname.includes("system")) continue;
        const refDoc = await mongoose.connection.collection(cname).findOne({ _id: cfg.product_for_seller });
        if (refDoc) {
            console.log(`BINGO! Reference found in collection: ${cname}`, refDoc);
        }
    }

    await mongoose.disconnect();
})();
