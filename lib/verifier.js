var $ = require('preconditions').singleton();
var _ = require('lodash');

var Bitcore = require('alohacore-lib');

var Common = require('./common');
var Utils = Common.Utils;

var log = require('./log');

/**
 * @desc Verifier constructor. Checks data given by the server
 *
 * @constructor
 */
function Verifier(opts) {};

/**
 * Check address
 *
 * @param {Function} credentials
 * @param {String} address
 * @returns {Boolean} true or false
 */
Verifier.checkAddress = function(credentials, address) {
  $.checkState(credentials.isComplete());

  var local = Utils.deriveAddress(address.type || credentials.addressType, credentials.publicKeyRing, address.path, credentials.m, credentials.network);
  return (local.address == address.address &&
    _.difference(local.publicKeys, address.publicKeys).length === 0);
};

/**
 * Check copayers
 *
 * @param {Function} credentials
 * @param {Array} copayers
 * @returns {Boolean} true or false
 */
Verifier.checkCopayers = function(credentials, copayers) {
  $.checkState(credentials.walletPrivKey);
  var walletPubKey = Bitcore.PrivateKey.fromString(credentials.walletPrivKey).toPublicKey().toString();

  if (copayers.length != credentials.n) {
    log.error('Missing public keys in server response');
    return false;
  }

  // Repeated xpub kes?
  var uniq = [];
  var error;
  _.each(copayers, function(copayer) {
    if (error) return;

    if (uniq[copayers.xPubKey]++) {
      log.error('Repeated public keys in server response');
      error = true;
    }

    // Not signed pub keys
    if (!(copayer.encryptedName || copayer.name) || !copayer.xPubKey || !copayer.requestPubKey || !copayer.signature) {
      log.error('Missing copayer fields in server response');
      error = true;
    } else {
      var hash = Utils.getCopayerHash(copayer.encryptedName || copayer.name, copayer.xPubKey, copayer.requestPubKey);
      if (!Utils.verifyMessage(hash, copayer.signature, walletPubKey)) {
        log.error('Invalid signatures in server response');
        error = true;
      }
    }
  });

  if (error) return false;

  if (!_.includes(_.pluck(copayers, 'xPubKey'), credentials.xPubKey)) {
    log.error('Server response does not contains our public keys')
    return false;
  }
  return true;
};

Verifier.checkProposalCreation = function(args, txp, encryptingKey) {
  function strEqual(str1, str2) {
    return ((!str1 && !str2) || (str1 === str2));
  }
  console.log("Verifier.checkProposalCreation() ", "one");
  if (txp.outputs.length != args.outputs.length) return false;

  console.log("Verifier.checkProposalCreation() ", "two");
  for (var i = 0; i < txp.outputs.length; i++) {
    var o1 = txp.outputs[i];
    var o2 = args.outputs[i];
    if (!strEqual(o1.toAddress, o2.toAddress)) return false;
    if (!strEqual(o1.script, o2.script)) return false;
    if (o1.amount != o2.amount) {
      console.log("Verifier.checkProposalCreation() amounts not equal: ", o1.amount, o2.amount);
      return false;
    }
    var decryptedMessage = null;
    try {
      decryptedMessage = Utils.decryptMessage(o2.message, encryptingKey);
    } catch (e) {
      console.log("Verifier.checkProposalCreation() ", "fail decrypt msg");
      return false;
    }
    if (!strEqual(o1.message, decryptedMessage)) {
      console.log("Verifier.checkProposalCreation() ", "messages not equal");
      return false;
    }
  }

  var changeAddress;
  if (txp.changeAddress) {
    changeAddress = txp.changeAddress.address;
  }

  if (args.changeAddress && !strEqual(changeAddress, args.changeAddress)) return false;
  if (_.isNumber(args.feePerKb) && (txp.feePerKb != args.feePerKb)) {
    console.log("Verifier.checkProposalCreation() fail: txp.feePer %s Kb != args.feePerKb %s", txp.feePerKb, args.feePerKb);
    return false;
  }
  if (!strEqual(txp.payProUrl, args.payProUrl)) return false;

  var decryptedMessage = null;
  try {
    decryptedMessage = Utils.decryptMessage(args.message, encryptingKey);
  } catch (e) {
    console.log("Verifier.checkProposalCreation() no decrypt ", "");
    return false;
  }
  if (!strEqual(txp.message, decryptedMessage)) {
    console.log("Verifier.checkProposalCreation() ", "not equal txp.message ", txp.message, decryptedMessage);
    return false;
  }
  if (args.customData && !_.isEqual(txp.customData, args.customData)) return false;

  return true;
};

Verifier.checkTxProposalSignature = function(credentials, txp) {
  console.log("Verifier.checkTxProposalSignature()");
  $.checkArgument(txp.creatorId);
  console.log("  txp.creatorId ", txp.creatorId);
  $.checkState(credentials.isComplete());
  console.log("  credentials.isComplete()");

  var creatorKeys = _.find(credentials.publicKeyRing, function(item) {
    if (Utils.xPubToCopayerId(item.xPubKey) === txp.creatorId) return true;
  });
  console.log("  creatorKeys: " + creatorKeys);

  if (!creatorKeys) return false;
  var creatorSigningPubKey;

  // If the txp using a selfsigned pub key?
  if (txp.proposalSignaturePubKey) {
    console.log("  txp.proposalSignaturePubKey: ", txp.proposalSignaturePubKey);

    // Verify it...
    if (!Utils.verifyRequestPubKey(txp.proposalSignaturePubKey, txp.proposalSignaturePubKeySig, creatorKeys.xPubKey)) {
      console.log("  !Utils.verifyRequestPubKey()");
      return false;
    }
    
    creatorSigningPubKey = txp.proposalSignaturePubKey;
  } else {
    console.log("  creatorKeys.requestPubKey: ", creatorKeys.requestPubKey);
    creatorSigningPubKey = creatorKeys.requestPubKey;
  }
  if (!creatorSigningPubKey) {
    console.log("  !creatorSigningPubKey");
    return false;
  }

  var hash;
  if (parseInt(txp.version) >= 3) {
    console.log("  Utils.buildTx(txp)");
    var t = Utils.buildTx(txp);
    hash = t.uncheckedSerialize();
    console.log("  -> raw hash %s will be passed as the text to verifyMessage()", hash);
  } else {
    throw new Error('Transaction proposal not supported');
  }

  console.log('Regenerating & verifying tx proposal hash -> Hash: ', hash, ' Signature: ', txp.proposalSignature);
  log.debug('Regenerating & verifying tx proposal hash -> Hash: ', hash, ' Signature: ', txp.proposalSignature);
  if (!Utils.verifyMessage(hash, txp.proposalSignature, creatorSigningPubKey)) {
    console.log("  !Utils.verifyMessage(hash, txp.proposalSignature, creatorSigningPubKey)");
    return false;
  }
  
  if (!Verifier.checkAddress(credentials, txp.changeAddress)) {
    console.log("  !Verifier.checkAddress(credentials, txp.changeAddress)");
    return false;
  }
  
  return true;
};


Verifier.checkPaypro = function(txp, payproOpts) {
  var toAddress, amount;

  if (parseInt(txp.version) >= 3) {
    toAddress = txp.outputs[0].toAddress;
    amount = txp.amount;
  } else {
    toAddress = txp.toAddress;
    amount = txp.amount;
  }

  return (toAddress == payproOpts.toAddress && amount == payproOpts.amount);
};


/**
 * Check transaction proposal
 *
 * @param {Function} credentials
 * @param {Object} txp
 * @param {Object} Optional: paypro
 * @param {Boolean} isLegit
 */
Verifier.checkTxProposal = function(credentials, txp, opts) {
  opts = opts || {};
  console.log("Verifier.checkTxProposal() ");
  console.log("  txp: " + JSON.stringify(txp));
  if (!this.checkTxProposalSignature(credentials, txp)) {
    console.log("  !this.checkTxProposalSignature(credentials, txp)");
    return false;
  }

  if (opts.paypro && !this.checkPaypro(txp, opts.paypro)) {
    console.log("  opts.paypro [" + opts.paypro + "] && !this.checkPaypro(txp, opts.paypro)");
    return false;
  }

  return true;
};

module.exports = Verifier;
