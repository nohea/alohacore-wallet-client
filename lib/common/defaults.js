'use strict';

var Defaults = {};

Defaults.COIN = 1e8; // Bitcoin satoshis
Defaults.PEERCOIN_COIN = 1e6; // Peercoin smallest unit sunnys
Defaults.DEFAULT_FEE_PER_KB = Defaults.COIN / 1e3;
Defaults.MIN_FEE_PER_KB = 0;
Defaults.MAX_FEE_PER_KB = Defaults.COIN;
Defaults.MAX_TX_FEE = 1 * Defaults.COIN;

module.exports = Defaults;
