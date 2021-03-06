'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var sjcl = require('sjcl');
var Stringify = require('json-stable-stringify');

var Bitcore = require('alohacore-lib');
var Address = Bitcore.Address;
var PrivateKey = Bitcore.PrivateKey;
var PublicKey = Bitcore.PublicKey;
var crypto = Bitcore.crypto;
var encoding = Bitcore.encoding;

var Constants = require('./constants');
var Defaults = require('./defaults');

function Utils() {};

Utils.SJCL = {};

Utils.encryptMessage = function(message, encryptingKey) {
  var key = sjcl.codec.base64.toBits(encryptingKey);
  return sjcl.encrypt(key, message, _.defaults({
    ks: 128,
    iter: 1,
  }, Utils.SJCL));
};

Utils.decryptMessage = function(cyphertextJson, encryptingKey) {
  try {
    var key = sjcl.codec.base64.toBits(encryptingKey);
    return sjcl.decrypt(key, cyphertextJson);
  } catch (ex) {
    return cyphertextJson;
  }
};

/* TODO: It would be nice to be compatible with bitcoind signmessage. How
 * the hash is calculated there? */
Utils.hashMessage = function(text) {
  $.checkArgument(text);
  var buf = new Buffer(text);
  var ret = crypto.Hash.sha256sha256(buf);
  ret = new Bitcore.encoding.BufferReader(ret).readReverse();
  return ret;
};


Utils.signMessage = function(text, privKey) {
  $.checkArgument(text);
  console.log("Utils.signMessage()");
  var priv = new PrivateKey(privKey);
  var hash = Utils.hashMessage(text);
  console.log("  hash: ", hash);
  var signed = crypto.ECDSA.sign(hash, priv, 'little').toString();
  return signed;
};


Utils.verifyMessage = function(text, signature, pubKey) {
  console.log("bws client Utils.verifyMessage(text, signature, pubKey)");
  console.log("  text, signature, pubKey: ", text, signature, pubKey);
  $.checkArgument(text);
  $.checkArgument(pubKey);

  if (!signature)
    return false;

  var pub = new PublicKey(pubKey);
  var hash = Utils.hashMessage(text);

  try {
    var sig = new crypto.Signature.fromString(signature);
    var verified = crypto.ECDSA.verify(hash, sig, pub, 'little');
    console.log("  crypto.ECDSA verified: ", verified);
    return verified;
  } catch (e) {
    console.log("  crypto.ECDSA.verify() Error: ", JSON.stringify(e));;
    return false;
  }
};

Utils.privateKeyToAESKey = function(privKey) {
  $.checkArgument(privKey && _.isString(privKey));
  $.checkArgument(Bitcore.PrivateKey.isValid(privKey), 'The private key received is invalid');
  var pk = Bitcore.PrivateKey.fromString(privKey);
  return Bitcore.crypto.Hash.sha256(pk.toBuffer()).slice(0, 16).toString('base64');
};

Utils.getCopayerHash = function(name, xPubKey, requestPubKey) {
  return [name, xPubKey, requestPubKey].join('|');
};

Utils.getProposalHash = function(proposalHeader) {
  function getOldHash(toAddress, amount, message, payProUrl) {
    return [toAddress, amount, (message || ''), (payProUrl || '')].join('|');
  };

  // For backwards compatibility
  if (arguments.length > 1) {
    return getOldHash.apply(this, arguments);
  }

  return Stringify(proposalHeader);
};

Utils.deriveAddress = function(scriptType, publicKeyRing, path, m, network) {
  $.checkArgument(_.includes(_.values(Constants.SCRIPT_TYPES), scriptType));

  var publicKeys = _.map(publicKeyRing, function(item) {
    var xpub = new Bitcore.HDPublicKey(item.xPubKey);
    return xpub.deriveChild(path).publicKey;
  });

  var bitcoreAddress;
  switch (scriptType) {
    case Constants.SCRIPT_TYPES.P2SH:
      bitcoreAddress = Address.createMultisig(publicKeys, m, network);
      break;
    case Constants.SCRIPT_TYPES.P2PKH:
      $.checkState(_.isArray(publicKeys) && publicKeys.length == 1);
      bitcoreAddress = Address.fromPublicKey(publicKeys[0], network);
      break;
  }

  return {
    address: bitcoreAddress.toString(),
    path: path,
    publicKeys: _.invoke(publicKeys, 'toString'),
  };
};

Utils.xPubToCopayerId = function(xpub) {
  var hash = sjcl.hash.sha256.hash(xpub);
  return sjcl.codec.hex.fromBits(hash);
};

Utils.signRequestPubKey = function(requestPubKey, xPrivKey) {
  var priv = new Bitcore.HDPrivateKey(xPrivKey).deriveChild(Constants.PATHS.REQUEST_KEY_AUTH).privateKey;
  return Utils.signMessage(requestPubKey, priv);
};

Utils.verifyRequestPubKey = function(requestPubKey, signature, xPubKey) {
  var pub = (new Bitcore.HDPublicKey(xPubKey)).deriveChild(Constants.PATHS.REQUEST_KEY_AUTH).publicKey;
  return Utils.verifyMessage(requestPubKey, signature, pub.toString());
};

Utils.formatAmount = function(satoshis, unit, opts) {
  $.shouldBeNumber(satoshis);
  $.checkArgument(_.includes(_.keys(Constants.UNITS), unit));

  function clipDecimals(number, decimals) {
    var x = number.toString().split('.');
    var d = (x[1] || '0').substring(0, decimals);
    return parseFloat(x[0] + '.' + d);
  };

  function addSeparators(nStr, thousands, decimal, minDecimals) {
    nStr = nStr.replace('.', decimal);
    var x = nStr.split(decimal);
    var x0 = x[0];
    var x1 = x[1];

    x1 = _.dropRightWhile(x1, function(n, i) {
      return n == '0' && i >= minDecimals;
    }).join('');
    var x2 = x.length > 1 ? decimal + x1 : '';

    x0 = x0.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
    return x0 + x2;
  };

  opts = opts || {};

  var u = Constants.UNITS[unit];
  var precision = opts.fullPrecision ? 'full' : 'short';
  var amount = clipDecimals((satoshis / u.toSatoshis), u[precision].maxDecimals).toFixed(u[precision].maxDecimals);
  return addSeparators(amount, opts.thousandsSeparator || ',', opts.decimalSeparator || '.', u[precision].minDecimals);
};

Utils.buildTx = function(txp) {
  var t = new Bitcore.Transaction();

  $.checkState(_.includes(_.values(Constants.SCRIPT_TYPES), txp.addressType));

  switch (txp.addressType) {
    case Constants.SCRIPT_TYPES.P2SH:
      _.each(txp.inputs, function(i) {
        t.from(i, i.publicKeys, txp.requiredSignatures);
      });
      break;
    case Constants.SCRIPT_TYPES.P2PKH:
      t.from(txp.inputs);
      break;
  }

  if (txp.toAddress && txp.amount && !txp.outputs) {
    t.to(txp.toAddress, txp.amount);
  } else if (txp.outputs) {
    _.each(txp.outputs, function(o) {
      $.checkState(o.script || o.toAddress, 'Output should have either toAddress or script specified');
      if (o.script) {
        t.addOutput(new Bitcore.Transaction.Output({
          script: o.script,
          satoshis: o.amount
        }));
      } else {
        t.to(o.toAddress, o.amount);
      }
    });
  }

  t.fee(txp.fee);

  if (txp.changeAddress) {
    t.change(txp.changeAddress.address);
  }

  // Shuffle outputs for improved privacy
  if (t.outputs.length > 1) {
    var outputOrder = _.reject(txp.outputOrder, function(order) {
      return order >= t.outputs.length;
    });
    $.checkState(t.outputs.length == outputOrder.length);
    t.sortOutputs(function(outputs) {
      return _.map(outputOrder, function(i) {
        return outputs[i];
      });
    });
  }

  // Validate inputs vs outputs independently of Bitcore
  var totalInputs = _.reduce(txp.inputs, function(memo, i) {
    return +i.satoshis + memo;
  }, 0);
  var totalOutputs = _.reduce(t.outputs, function(memo, o) {
    return +o.satoshis + memo;
  }, 0);

  $.checkState(totalInputs - totalOutputs >= 0);
  $.checkState(totalInputs - totalOutputs <= Defaults.MAX_TX_FEE);

  return t;
};

Utils.convertTxpSatoshiToCoinProtocol = function(opts, fromSatToCoin, toSatToCoin) {
  var self = this;

  // this is to adjust the satoshi to coin ratio in the tx proposal, before
  // before it is signed or is written to the rawtx
  // In Peercoin we have to use 1 / (1e8 / 1e6) = 0.01
  // to convert from Bitcoin to Peercoin,
  // fromSatToCoin = 1e8, toSatToCoin = 1e6
  if( ! fromSatToCoin ) {
    fromSatToCoin = Defaults.COIN;
  }
  if( ! toSatToCoin ) {
    toSatToCoin = Defaults.COIN;
  }
  var coinRatio = 1 / (fromSatToCoin / toSatToCoin);
  console.log("convertTxpSatoshiToCoinProtocol() : coinRatio: ", coinRatio);

  console.log("  incoming: ", opts, "\n");

  if( _.isNumber(opts.feeLevel) ) {
    opts.feeLevel = opts.feeLevel * coinRatio;
  }
  if( _.isNumber(opts.feePerKb) ) {
    opts.feePerKb = opts.feePerKb * coinRatio;
  }
  if( _.isNumber(opts.fee) ) {
    opts.fee = opts.fee * coinRatio;
  }

  if(opts.outputs) {
    for (var i = 0; i < opts.outputs.length; i++) {
      var output = opts.outputs[i];
      if( _.isNumber(output.amount) ) {
	opts.outputs[i].amount = output.amount * coinRatio;
      }
    }
  }

  if(opts.inputs) {
    for (var i = 0; i < opts.inputs.length; i++) {
      var input = opts.inputs[i];
      if( _.isNumber(input.satoshis) ) {
	opts.inputs[i].satoshis = input.satoshis * coinRatio;
      }
    }
  }

  if( opts.amount ) {
    opts.amount = opts.amount * coinRatio;
  }

  console.log("  outgoing: ", opts, "\n");

  return opts;
};

module.exports = Utils;
