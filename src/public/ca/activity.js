// Journey Builder config modal: reads/writes inArguments via Postmonger.
(function () {
  var kind = document.body.dataset.kind;
  var connection = new Postmonger.Session();
  var payload = {};
  var fields = kind === 'sync' ? ['threshold'] : ['delaySec', 'cdcMode'];

  connection.on('initActivity', function (data) {
    payload = data || {};
    var args = Object.assign.apply(null, [{}].concat((payload.arguments && payload.arguments.execute && payload.arguments.execute.inArguments) || []));
    fields.forEach(function (f) { if (args[f] != null && args[f] !== '') document.getElementById(f).value = args[f]; });
  });

  connection.on('clickedNext', function () {
    var inArgs = [{ contactKey: '{{Contact.Key}}' }];
    fields.forEach(function (f) {
      var v = document.getElementById(f).value;
      if (v !== '') { var o = {}; o[f] = v; inArgs.push(o); }
    });
    payload.arguments = payload.arguments || {};
    payload.arguments.execute = payload.arguments.execute || {};
    payload.arguments.execute.inArguments = inArgs;
    payload.metaData = payload.metaData || {};
    payload.metaData.isConfigured = true;
    connection.trigger('updateActivity', payload);
  });

  connection.trigger('ready');
})();
