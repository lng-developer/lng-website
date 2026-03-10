require('dotenv').config()
const mongoose = require('mongoose')
const db = require('../src/models')

    ; (async () => {
        try {
            await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.DB_NAME })
            const User = db.user || db.User
            if (!User) throw new Error('User model not found on db export')

            const result = await User.updateMany(
                { revokeAllBefore: { $exists: false } },
                { $set: { revokeAllBefore: new Date(0) } }
            )
            console.log('✅ Updated users:', result.modifiedCount ?? result.nModified)
            process.exit(0)
        } catch (e) {
            console.error('❌ Error:', e.message)
            process.exit(1)
        }
    })()
