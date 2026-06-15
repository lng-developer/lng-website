require("./env.config")();
module.exports = {
    secret: process.env.JWT_SECRET,
    jwtExpiration: 86400, //1h
    jwtRefreshExpriration: 86400 //24h
}
